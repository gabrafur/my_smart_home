"""Coordinator for Hyundai / Kia Connect integration."""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import logging
import time
import traceback
import types
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.components.recorder import history
from homeassistant.const import (
    CONF_PASSWORD,
    CONF_PIN,
    CONF_REGION,
    CONF_SCAN_INTERVAL,
    CONF_USERNAME,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from hyundai_kia_connect_api import (
    ClimateRequestOptions,
    POIInfo,
    ScheduleChargingClimateRequestOptions,
    Token,
    Vehicle,
    VehicleManager,
    WindowRequestOptions,
)
from hyundai_kia_connect_api.const import WINDOW_STATE
from hyundai_kia_connect_api.exceptions import (
    AuthenticationError,
    UnsupportedControlError,
)
from hyundai_kia_connect_api.ApiImplType1 import ApiImplType1

from .const import (
    CONF_BRAND,
    CONF_ENABLE_GEOLOCATION_ENTITY,
    CONF_FORCE_REFRESH_INTERVAL,
    CONF_NO_FORCE_REFRESH_HOUR_FINISH,
    CONF_NO_FORCE_REFRESH_HOUR_START,
    CONF_TOKEN,
    CONF_USE_EMAIL_WITH_GEOCODE_API,
    DEFAULT_ENABLE_GEOLOCATION_ENTITY,
    DEFAULT_FORCE_REFRESH_INTERVAL,
    DEFAULT_NO_FORCE_REFRESH_HOUR_FINISH,
    DEFAULT_NO_FORCE_REFRESH_HOUR_START,
    DEFAULT_SCAN_INTERVAL,
    DEFAULT_USE_EMAIL_WITH_GEOCODE_API,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

# Segundos de espera entre acordar o veiculo e ler o snapshot ja fresco.
# 25 s e o valor medido em campo pelo upstream (KiaUvoApiEU) para um CCS2
# alcancavel; abaixo disso o /latest ainda devolve o estado antigo.
BR_WAKE_SETTLE_SECONDS = 25

# Piso de seguranca entre dois wakes reais. Acordar o carro puxa a bateria de
# 12 V e conta contra o rate limit da Hyundai - e' por isso que o options flow
# do kia_uvo trava o force interval proprio da integracao em 90 min. Quem
# aperta button.*_force_refresh direto (o flow iluminacao_seguranca no
# Node-RED) contorna esse piso, entao mantemos um aqui, que ninguem contorna.
BR_WAKE_MIN_INTERVAL_S = 15 * 60
FUEL_TANK_LITERS = 50.0
MIN_FUEL_DROP_PERCENT = 2.0
MAX_READING_GAP = timedelta(hours=4)


class HyundaiKiaConnectDataUpdateCoordinator(DataUpdateCoordinator):
    """Class to manage fetching data from the API."""

    def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry) -> None:
        """Initialize."""
        self.platforms: set[str] = set()
        self._action_lock = asyncio.Lock()
        # The Brazilian API exposes one calendar day per request. Keep the
        # dashboard window separate from vehicle.day_trip_info so that the
        # existing entity continues to mean "today".
        self.recent_trip_info: dict[str, dict[str, Any]] = {}
        self.fuel_efficiency: dict[str, dict[str, Any]] = {}
        self._last_trip_refresh_odometer: dict[str, float] = {}

        self.vehicle_manager = VehicleManager(
            region=config_entry.data.get(CONF_REGION),
            brand=config_entry.data.get(CONF_BRAND),
            username=config_entry.data.get(CONF_USERNAME),
            password=config_entry.data.get(CONF_PASSWORD),
            pin=config_entry.data.get(CONF_PIN),
            geocode_api_enable=config_entry.options.get(
                CONF_ENABLE_GEOLOCATION_ENTITY, DEFAULT_ENABLE_GEOLOCATION_ENTITY
            ),
            geocode_api_use_email=config_entry.options.get(
                CONF_USE_EMAIL_WITH_GEOCODE_API, DEFAULT_USE_EMAIL_WITH_GEOCODE_API
            ),
            language=hass.config.language,
            token=Token.from_dict(config_entry.data.get(CONF_TOKEN, None))
            if config_entry.data.get(CONF_TOKEN, None)
            else None,
        )
        self.scan_interval: int = (
            config_entry.options.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL) * 60
        )
        self.force_refresh_interval: int = (
            config_entry.options.get(
                CONF_FORCE_REFRESH_INTERVAL, DEFAULT_FORCE_REFRESH_INTERVAL
            )
            * 60
        )
        self.no_force_refresh_hour_start: int = config_entry.options.get(
            CONF_NO_FORCE_REFRESH_HOUR_START, DEFAULT_NO_FORCE_REFRESH_HOUR_START
        )
        self.no_force_refresh_hour_finish: int = config_entry.options.get(
            CONF_NO_FORCE_REFRESH_HOUR_FINISH, DEFAULT_NO_FORCE_REFRESH_HOUR_FINISH
        )
        self.enable_geolocation_entity = config_entry.options.get(
            CONF_ENABLE_GEOLOCATION_ENTITY, DEFAULT_ENABLE_GEOLOCATION_ENTITY
        )
        self.use_email_with_geocode_api = config_entry.options.get(
            CONF_USE_EMAIL_WITH_GEOCODE_API, DEFAULT_USE_EMAIL_WITH_GEOCODE_API
        )

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(
                seconds=min(self.scan_interval, self.force_refresh_interval)
            ),
        )
        _LOGGER.debug(
            "%s - Polling configured: scan_interval=%ds, "
            "force_refresh_interval=%ds, update_interval=%ds, "
            "no_force_refresh_hours=%d-%d",
            DOMAIN,
            self.scan_interval,
            self.force_refresh_interval,
            min(self.scan_interval, self.force_refresh_interval),
            self.no_force_refresh_hour_start,
            self.no_force_refresh_hour_finish,
        )

    async def _async_update_data(self):
        """Update data via library. Called by update_coordinator periodically.

        Allow to update for the first time without further checking
        Allow force update, if time diff between latest update and `now` is greater than force refresh delta
        """
        _LOGGER.debug(
            "%s - _async_update_data called, scan_interval=%ds, force_refresh_interval=%ds",
            DOMAIN,
            self.scan_interval,
            self.force_refresh_interval,
        )
        try:
            await self.async_check_and_refresh_token()
        except AuthenticationError as AuthError:
            raise ConfigEntryAuthFailed(AuthError) from AuthError
        except Exception as err:
            # Transient API errors (e.g. DeviceIDError, ReadTimeoutError) from
            # Kia's EU backend must be surfaced as UpdateFailed rather than
            # propagating as unexpected exceptions.  HA's update coordinator
            # counts unexpected exceptions and cancels the config entry after
            # enough consecutive failures, which makes all entities permanently
            # unavailable until the integration is manually reloaded.
            # Raising UpdateFailed(retry_after=60) keeps entities temporarily
            # unavailable and schedules an automatic retry after 60 seconds
            # instead of waiting for the next full poll interval.
            # See: https://github.com/Hyundai-Kia-Connect/kia_uvo/issues/1538
            raise UpdateFailed(
                f"Token refresh failed, will retry in 60s: {err}",
                retry_after=60,
            ) from err
        self._force_ccs2_status_endpoint()
        self._install_br_wake_force_refresh()
        current_hour = dt_util.now().hour

        if (
            (self.no_force_refresh_hour_start <= self.no_force_refresh_hour_finish)
            and (
                current_hour < self.no_force_refresh_hour_start
                or current_hour >= self.no_force_refresh_hour_finish
            )
        ) or (
            (self.no_force_refresh_hour_start >= self.no_force_refresh_hour_finish)
            and (
                current_hour < self.no_force_refresh_hour_start
                and current_hour >= self.no_force_refresh_hour_finish
            )
        ):
            try:
                await self.hass.async_add_executor_job(
                    self.vehicle_manager.check_and_force_update_vehicles,
                    self.force_refresh_interval,
                )
            except Exception:
                try:
                    _LOGGER.exception(
                        f"Force update failed, falling back to cached: {traceback.format_exc()}"
                    )
                    await self.hass.async_add_executor_job(
                        self.vehicle_manager.update_all_vehicles_with_cached_state
                    )
                except Exception:
                    _LOGGER.exception(f"Cached update failed: {traceback.format_exc()}")
                    raise UpdateFailed(
                        f"Error communicating with API: {traceback.format_exc()}"
                    )

        else:
            await self.hass.async_add_executor_job(
                self.vehicle_manager.update_all_vehicles_with_cached_state
            )

        await self._async_refresh_trip_info_on_new_distance()

        return self.data

    async def _async_refresh_trip_info_on_new_distance(self) -> None:
        """Refresh trip history when vehicle telemetry confirms new driving.

        Polling itself must not repeatedly hit the rate-limited /tripinfo
        endpoint. Odometer movement is the authoritative signal that a new
        trip can exist, including trips that do not end at home.
        """
        for vehicle_id, vehicle in self.vehicle_manager.vehicles.items():
            odometer = getattr(vehicle, "_odometer", None)
            value = odometer[0] if isinstance(odometer, tuple) else odometer
            try:
                current = float(value)
            except (TypeError, ValueError):
                continue
            previous = self._last_trip_refresh_odometer.get(vehicle_id)
            self._last_trip_refresh_odometer[vehicle_id] = current
            # Establish a baseline at startup; the next genuine movement
            # triggers the refresh without causing an API burst on reload.
            if previous is None or current <= previous + 0.05:
                continue
            _LOGGER.debug(
                "%s - odometer advanced %.2f km; refreshing trip history",
                DOMAIN,
                current - previous,
            )
            await self.async_refresh_day_trip_info(vehicle_id)

    async def async_update_all(self) -> None:
        """Update vehicle data."""
        await self.async_check_and_refresh_token()
        await self.hass.async_add_executor_job(
            self.vehicle_manager.update_all_vehicles_with_cached_state
        )
        self.async_set_updated_data(self.data)

    async def async_force_update_all(self) -> None:
        """Force refresh vehicle data and update it."""
        await self.async_check_and_refresh_token()
        await self.hass.async_add_executor_job(
            self.vehicle_manager.force_refresh_all_vehicles_states
        )
        self.async_set_updated_data(self.data)

    async def async_force_refresh_vehicle(self, vehicle_id: str) -> None:
        """Force refresh a single vehicle's state."""
        await self.async_check_and_refresh_token()
        await self.hass.async_add_executor_job(
            self.vehicle_manager.force_refresh_vehicle_state, vehicle_id
        )
        self.async_set_updated_data(self.data)

    async def async_refresh_day_trip_info(self, vehicle_id: str) -> None:
        """Fetch today's trip log and the preceding calendar day.

        This hits a different endpoint (/tripinfo) than the regular status
        poll. The BR backend only ever reports live "engine" state at
        parking events (mirrors the /location/park 400-while-driving
        behavior), so binary_sensor.*_engine's recorder history is a sparse
        reconstruction of whatever moments we happened to poll and can miss
        "on" entirely during a drive. This trip log is the same data the
        Bluelink app's own trip history is built from, so it matches the
        app regardless of polling luck.
        """
        await self.async_check_and_refresh_token()
        today = dt_util.now().date()
        requested_days = (today, today - dt.timedelta(days=1))
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        days: list[dict[str, Any]] = []

        for trip_date in requested_days:
            yyyymmdd_string = trip_date.strftime("%Y%m%d")
            # The upstream BR client retains the preceding result when the
            # API returns no trips. Clear it first to avoid displaying stale
            # trips under the other date.
            vehicle.day_trip_info = None
            await self.hass.async_add_executor_job(
                self.vehicle_manager.update_day_trip_info,
                vehicle_id,
                yyyymmdd_string,
            )
            info = vehicle.day_trip_info
            trips: list[dict[str, Any]] = []
            if info is not None:
                for trip in info.trip_list:
                    start = str(trip.hhmmss or "")
                    drive_time = trip.drive_time
                    idle_time = trip.idle_time
                    duration = (
                        drive_time + idle_time
                        if isinstance(drive_time, (int, float))
                        and isinstance(idle_time, (int, float))
                        else None
                    )
                    end_time = None
                    if len(start) == 6 and duration is not None:
                        try:
                            started_at = dt.datetime.strptime(
                                f"{yyyymmdd_string}{start}", "%Y%m%d%H%M%S"
                            )
                            end_time = (
                                started_at + dt.timedelta(minutes=duration)
                            ).strftime("%H:%M")
                        except ValueError:
                            pass
                    started_at_iso = None
                    if len(start) == 6:
                        try:
                            started_at_iso = dt.datetime.strptime(
                                f"{yyyymmdd_string}{start}", "%Y%m%d%H%M%S"
                            ).isoformat()
                        except ValueError:
                            pass
                    trips.append(
                        {
                            "date": yyyymmdd_string,
                            "start_time": start,
                            "end_time": end_time,
                            "drive_time_min": drive_time,
                            "idle_time_min": idle_time,
                            "duration_min": duration,
                            "distance": trip.distance,
                            "avg_speed": trip.avg_speed,
                            "max_speed": trip.max_speed,
                            "started_at": started_at_iso,
                        }
                    )
            days.append(
                {
                    "date": yyyymmdd_string,
                    "total_distance": info.summary.distance if info and info.summary else 0,
                    "total_drive_time_min": info.summary.drive_time if info and info.summary else 0,
                    "total_idle_time_min": info.summary.idle_time if info and info.summary else 0,
                    "trips": trips,
                }
            )

        self.recent_trip_info[vehicle_id] = {
            "period_start": requested_days[-1].strftime("%Y%m%d"),
            "period_end": requested_days[0].strftime("%Y%m%d"),
            "days": days,
            "trips": sorted(
                (trip for day in days for trip in day["trips"]),
                key=lambda trip: (trip["date"], trip["start_time"]),
                reverse=True,
            ),
            "total_distance": sum(day["total_distance"] or 0 for day in days),
            "total_drive_time_min": sum(day["total_drive_time_min"] or 0 for day in days),
        }
        await self._async_update_fuel_efficiency(vehicle_id)
        # Restore the established contract of sensor.*_day_trip_info after the
        # second request (yesterday): it must continue to represent today.
        await self.hass.async_add_executor_job(
            self.vehicle_manager.update_day_trip_info,
            vehicle_id,
            today.strftime("%Y%m%d"),
        )
        self.async_set_updated_data(self.data)

    async def _async_update_fuel_efficiency(self, vehicle_id: str) -> None:
        """Estimate km/L only where recorder readings safely bracket a trip."""
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        registry = er.async_get(self.hass)
        fuel_entity_id = registry.async_get_entity_id(
            "sensor", DOMAIN, f"{DOMAIN}_{vehicle.id}_fuel_level"
        )
        odometer_entity_id = registry.async_get_entity_id(
            "sensor", DOMAIN, f"{DOMAIN}_{vehicle.id}__odometer"
        )
        if not fuel_entity_id or not odometer_entity_id:
            return

        start = dt_util.utcnow() - timedelta(days=3)
        entity_ids = [fuel_entity_id, odometer_entity_id]
        states = await self.hass.async_add_executor_job(
            lambda: history.get_significant_states(
                self.hass,
                start,
                entity_ids=entity_ids,
                no_attributes=True,
            )
        )

        def numeric(entity_id: str) -> list[tuple[dt.datetime, float]]:
            result = []
            for state in states.get(entity_id, []):
                try:
                    result.append((state.last_updated, float(state.state)))
                except (TypeError, ValueError):
                    continue
            return result

        fuel_readings = numeric(fuel_entity_id)
        odometer_readings = numeric(odometer_entity_id)
        estimated_liters = 0.0
        estimated_distance = 0.0
        for trip in self.recent_trip_info[vehicle_id]["trips"]:
            if not trip["started_at"] or trip["duration_min"] is None:
                continue
            # tripinfo returns the vehicle's local wall-clock time. Recorder
            # timestamps are UTC, so convert via Home Assistant's configured
            # timezone before comparing the two histories.
            started = dt_util.as_utc(
                dt.datetime.fromisoformat(trip["started_at"]).replace(
                    tzinfo=self.hass.config.time_zone
                )
            )
            ended = started + timedelta(minutes=trip["duration_min"])
            before_fuel = next((item for item in reversed(fuel_readings) if item[0] <= started), None)
            after_fuel = next((item for item in fuel_readings if item[0] >= ended), None)
            before_odo = next((item for item in reversed(odometer_readings) if item[0] <= started), None)
            after_odo = next((item for item in odometer_readings if item[0] >= ended), None)
            if not all((before_fuel, after_fuel, before_odo, after_odo)):
                continue
            if any(
                abs(sample[0] - boundary) > MAX_READING_GAP
                for sample, boundary in ((before_fuel, started), (after_fuel, ended), (before_odo, started), (after_odo, ended))
            ):
                continue
            fuel_drop = before_fuel[1] - after_fuel[1]
            odometer_distance = after_odo[1] - before_odo[1]
            trip_distance = float(trip["distance"] or 0)
            if (
                fuel_drop < MIN_FUEL_DROP_PERCENT
                or odometer_distance < 0
                or abs(odometer_distance - trip_distance) > max(2.0, trip_distance * 0.2)
            ):
                continue
            liters = fuel_drop * FUEL_TANK_LITERS / 100
            if liters <= 0 or trip_distance <= 0:
                continue
            km_per_liter = round(trip_distance / liters, 1)
            trip["estimated_liters"] = round(liters, 2)
            trip["estimated_km_per_l"] = km_per_liter
            trip["consumption_source"] = "estimado por nível de combustível e odômetro"
            estimated_liters += liters
            estimated_distance += trip_distance

        average = round(estimated_distance / estimated_liters, 1) if estimated_liters else None
        self.fuel_efficiency[vehicle_id] = {
            "km_per_l": average,
            "estimated_distance": round(estimated_distance, 1),
            "estimated_liters": round(estimated_liters, 2),
            "tank_liters": FUEL_TANK_LITERS,
            "method": "Estimativa: distância da viagem ÷ (queda percentual × 50 L)",
        }
        self.recent_trip_info[vehicle_id]["fuel_efficiency"] = self.fuel_efficiency[vehicle_id]

    def _force_ccs2_status_endpoint(self) -> None:
        """Force the CCS2 status endpoint, overriding Hyundai's stale flag.

        The BR backend's /spa/vehicles list response includes a per-vehicle
        ccuCCS2ProtocolSupport flag that HyundaiBlueLinkApiBR._get_vehicle_state
        uses to pick between /status/latest (flag=0) and /ccs2/carstatus/latest
        (flag=1). For this Creta the flag has been reporting 0 the whole time,
        but /status/latest has returned a hard 503 (resCode 5031,
        "Unavailable remote control - Service Temporary Unavailable") since
        2026-07-14, while manually probing /ccs2/carstatus/latest with the
        same token on 2026-07-19 returned 200 with fresh vehicle data. i.e.
        Hyundai migrated this vehicle's backend to CCS2 without updating the
        capability flag their own vehicle-list endpoint reports. Force it
        every update instead of relying on the (wrong) upstream flag.

        The /ccs2/carstatus/latest response is a deeply nested schema
        (resMsg.state.Vehicle.Cabin.Door.Row1.Driver.Open, etc.), completely
        different from the flat /status/latest shape (resMsg.doorOpen.frontLeft)
        that HyundaiBlueLinkApiBR._update_vehicle_properties expects. Flipping
        the URL alone made the API call succeed but left every field parsed
        from the wrong shape (silently defaulting to None/False via .get()) -
        confirmed live: sensor.creta_fuel_level stayed "unavailable" even
        after status/latest 503s stopped. ApiImplType1 (used by other
        Hyundai/Kia regions that are CCS2-native) already ships a complete,
        battle-tested parser for this exact schema
        (_update_vehicle_properties_ccs2 - only self-dependency is
        self.data_timezone, which HyundaiBlueLinkApiBR also defines, so it's
        safe to bind onto our api instance). Rebinding
        api._update_vehicle_properties means update_vehicle_with_cached_state
        / force_refresh_vehicle_state (which call self._update_vehicle_properties
        internally, unaware of the swap) transparently get correct parsing.
        """
        api = self.vehicle_manager.api
        for vehicle in self.vehicle_manager.vehicles.values():
            vehicle.ccu_ccs2_protocol_support = True
        def _parse_ccs2(api_self, vehicle, resmsg):
            # HyundaiBlueLinkApiBR._get_vehicle_state returns response["resMsg"]
            # as-is, but ApiImplType1._update_vehicle_properties_ccs2 (as called
            # by KiaUvoApiEU/AU) expects resMsg["state"]["Vehicle"] - one level
            # deeper. Confirmed live: calling it with the bare resMsg crashed on
            # float(None) reading Drivetrain.FuelSystem.DTE.Total, which only
            # exists under state.Vehicle.
            inner = (resmsg or {}).get("state", {}).get("Vehicle", {})
            # The BR endpoint intermittently returns 70 for DTE.Unit although
            # this vehicle otherwise reports the metric enum 1. ApiImplType1
            # indexes its unit map directly, so that malformed value used to
            # make *every* vehicle entity unavailable. Keep vehicle.data raw,
            # but normalize only the parser input after logging the anomaly.
            parser_state = copy.deepcopy(inner)
            dte = parser_state.get("Drivetrain", {}).get("FuelSystem", {}).get("DTE", {})
            if dte.get("Unit") not in (0, 1, None):
                _LOGGER.warning("%s - invalid BR CCS2 DTE.Unit=%s; parsing as km", DOMAIN, dte["Unit"])
                dte["Unit"] = 1
            ApiImplType1._update_vehicle_properties_ccs2(api_self, vehicle, parser_state)
            # ApiImplType1's parser sets total_driving_range but never
            # fuel_driving_range (a BR-flat-parser-only field our sensor.py
            # SENSOR_DESCRIPTIONS already keys off of, entity
            # sensor.creta_fuel_driving_range) - confirmed by diffing every
            # "vehicle.X =" assignment between the two parsers, the only gap.
            # Alias it instead of touching sensor.py, so the existing
            # entity_id keeps working unchanged.
            if vehicle.total_driving_range is not None:
                vehicle.fuel_driving_range = (
                    vehicle.total_driving_range,
                    vehicle.total_driving_range_unit,
                )

        api._update_vehicle_properties = types.MethodType(_parse_ccs2, api)

    def _install_br_wake_force_refresh(self) -> None:
        """Faz o force refresh realmente ACORDAR o carro no backend BR.

        HyundaiBlueLinkApiBR.force_refresh_vehicle_state se anuncia como
        "wakes up the vehicle", mas so faz GET /ccs2/carstatus/latest - o
        snapshot em CACHE - com um header REFRESH: true que o backend BR
        ignora.

        Medido ao vivo em 2026-08-07: a chamada voltou em 160 ms (um poll real
        do veiculo leva 10-30 s) e binary_sensor.creta_engine ficou "off"
        durante 4 minutos de motor comprovadamente ligado, enquanto
        sensor.creta_last_scanned_at avancava - ou seja, reliamos estado velho
        da nuvem. Ao apertar o refresh no app Bluelink, o backend fez o poll de
        verdade e o nosso ciclo seguinte leu engine=on. O sensor nunca esteve
        quebrado; estava sem dado.

        KiaUvoApiEU._force_refresh_vehicle_state_ccs2 ja implementa a sequencia
        correta para veiculos CCS2; a classe BR simplesmente nunca a recebeu.
        Portada aqui: GET /ccs2/carstatus (sem /latest) acorda o carro, espera
        ele reportar, e so entao le o /latest ja fresco. O corpo do wake e um
        envelope de comando assincrono, nao o estado, entao e descartado - mas
        os erros propagam, para que um wake falho nunca caia em aplicar um
        snapshot velho (mesma razao do upstream EU).
        """
        api = self.vehicle_manager.api
        if type(api).__name__ != "HyundaiBlueLinkApiBR":
            return
        if not hasattr(self, "_br_last_wake_at"):
            self._br_last_wake_at = None

        # Parte SEMPRE da funcao da classe, nunca do atributo ja instalado na
        # instancia: _async_update_data roda isto a cada ciclo, e envolver o
        # wrapper anterior empilharia mais um sleep de 25 s por ciclo.
        original = type(api)._get_vehicle_state
        coordinator = self

        def _get_vehicle_state_waking(
            api_self, token, vehicle, force_refresh: bool = False
        ):
            if not force_refresh:
                return original(api_self, token, vehicle, force_refresh=False)

            now = dt_util.utcnow()
            last = coordinator._br_last_wake_at
            if (
                last is not None
                and (now - last).total_seconds() < BR_WAKE_MIN_INTERVAL_S
            ):
                _LOGGER.debug(
                    "%s - wake em cooldown (ultimo ha %.0fs, piso %ds); "
                    "lendo o snapshot em cache",
                    DOMAIN,
                    (now - last).total_seconds(),
                    BR_WAKE_MIN_INTERVAL_S,
                )
                return original(api_self, token, vehicle, force_refresh=False)

            headers = api_self._get_authenticated_headers(token)
            wake_url = api_self._build_api_url(
                f"/spa/vehicles/{vehicle.id}/ccs2/carstatus"
            )
            _LOGGER.debug("%s - acordando o veiculo: %s", DOMAIN, wake_url)
            _wake_resp = api_self.session.get(wake_url, headers=headers)
            _LOGGER.debug(
                "%s - resposta do wake [%s]: %s",
                DOMAIN, _wake_resp.status_code, _wake_resp.text[:600],
            )
            _wake_resp.json()
            coordinator._br_last_wake_at = now
            time.sleep(BR_WAKE_SETTLE_SECONDS)
            return original(api_self, token, vehicle, force_refresh=False)

        api._get_vehicle_state = types.MethodType(_get_vehicle_state_waking, api)

    async def async_check_and_refresh_token(self):
        """Refresh token if needed via library."""
        await self.hass.async_add_executor_job(
            self.vehicle_manager.check_and_refresh_token
        )
        await self._async_save_token()

    async def async_await_action_and_refresh(self, vehicle_id, action_id):
        try:
            await asyncio.sleep(5)
            await self.hass.async_add_executor_job(
                self.vehicle_manager.check_action_status,
                vehicle_id,
                action_id,
                True,
                60,
            )
        finally:
            await self.async_refresh()

    async def async_await_action_and_force_refresh(self, vehicle_id, action_id):
        """Wait for action then force refresh to get fresh vehicle data.

        Used after setting charge limits because the soft refresh (cmm/gvi)
        does not return targetSOC for some vehicles. A force refresh (rems/rvs)
        ensures the fresh charge limits are read back immediately.

        Uses async_set_updated_data instead of async_refresh to avoid a
        redundant cmm/gvi API call — the force refresh already updates the
        vehicle objects in-place (rems/rvs + cmm/gvi), so we just need to
        notify HA entities to re-read their state.
        """
        try:
            await asyncio.sleep(5)
            await self.hass.async_add_executor_job(
                self.vehicle_manager.check_action_status,
                vehicle_id,
                action_id,
                True,
                60,
            )
        finally:
            try:
                await self.hass.async_add_executor_job(
                    self.vehicle_manager.force_refresh_vehicle_state, vehicle_id
                )
            except Exception:
                _LOGGER.exception("Force refresh after call failed")
            self.async_set_updated_data(self.data)

    async def _async_send_action(
        self,
        vehicle_id: str,
        action_fn: Callable[[], Any],
        error_label: str,
        *,
        force_refresh: bool = False,
    ):
        """Send a vehicle action, wait for completion, and refresh data.

        Serializes actions with a lock to prevent DuplicateRequestError
        from the Hyundai API when commands overlap. If another action is
        already in progress, raises HomeAssistantError immediately so
        the user gets a clear message instead of a mysterious long wait.
        """
        if self._action_lock.locked():
            _LOGGER.warning(
                "Vehicle action '%s' rejected: another action is already in progress",
                error_label,
            )
            raise HomeAssistantError(
                "Another vehicle action is in progress. "
                "Please wait for it to complete and try again."
            )
        async with self._action_lock:
            await self.async_check_and_refresh_token()
            try:
                action_id = await self.hass.async_add_executor_job(action_fn)
            except UnsupportedControlError as err:
                raise HomeAssistantError(
                    f"Vehicle does not support this action: {err}"
                ) from err
            except Exception as err:
                raise HomeAssistantError(f"Failed to {error_label}: {err}") from err
            try:
                if force_refresh:
                    await self.async_await_action_and_force_refresh(
                        vehicle_id, action_id
                    )
                else:
                    await self.async_await_action_and_refresh(vehicle_id, action_id)
            except Exception:
                _LOGGER.exception(
                    "Action '%s' was sent but confirmation polling failed",
                    error_label,
                )

    async def async_lock_vehicle(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.lock(vehicle_id),
            "lock vehicle",
        )

    async def async_unlock_vehicle(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.unlock(vehicle_id),
            "unlock vehicle",
        )

    async def async_open_charge_port(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.open_charge_port(vehicle_id),
            "open charge port",
        )

    async def async_close_charge_port(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.close_charge_port(vehicle_id),
            "close charge port",
        )

    async def async_start_climate_default(self, vehicle_id: str):
        """Start climate with default options (API fills sensible defaults)."""
        await self.async_start_climate(vehicle_id, ClimateRequestOptions())

    async def async_start_climate(
        self, vehicle_id: str, climate_options: ClimateRequestOptions
    ):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.start_climate(vehicle_id, climate_options),
            "start climate",
        )

    async def async_stop_climate(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.stop_climate(vehicle_id),
            "stop climate",
        )

    async def async_start_charge(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.start_charge(vehicle_id),
            "start charge",
        )

    async def async_stop_charge(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.stop_charge(vehicle_id),
            "stop charge",
        )

    async def async_set_charge_limits(self, vehicle_id: str, ac: int, dc: int):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_charge_limits(vehicle_id, ac, dc),
            "set charge limits",
        )

    async def async_set_charging_current(self, vehicle_id: str, level: int):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_charging_current(vehicle_id, level),
            "set charging current",
        )

    async def async_schedule_charging_and_climate(
        self, vehicle_id: str, schedule_options: ScheduleChargingClimateRequestOptions
    ):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.schedule_charging_and_climate(
                vehicle_id, schedule_options
            ),
            "schedule charging and climate",
        )

    def _build_schedule_options_from_vehicle(
        self, vehicle: Vehicle
    ) -> ScheduleChargingClimateRequestOptions:
        """Build schedule options from current vehicle state for partial updates."""
        return ScheduleChargingClimateRequestOptions(
            first_departure=ScheduleChargingClimateRequestOptions.DepartureOptions(
                enabled=vehicle.ev_first_departure_enabled or False,
                days=vehicle.ev_first_departure_days or [0],
                time=vehicle.ev_first_departure_time or dt.time(),
            ),
            second_departure=ScheduleChargingClimateRequestOptions.DepartureOptions(
                enabled=vehicle.ev_second_departure_enabled or False,
                days=vehicle.ev_second_departure_days or [0],
                time=vehicle.ev_second_departure_time or dt.time(),
            ),
            charging_enabled=vehicle.ev_schedule_charge_enabled or False,
            off_peak_start_time=vehicle.ev_off_peak_start_time or dt.time(),
            off_peak_end_time=vehicle.ev_off_peak_end_time or dt.time(),
            off_peak_charge_only_enabled=vehicle.ev_off_peak_charge_only_enabled
            or False,
            climate_enabled=vehicle.ev_first_departure_climate_enabled or False,
            temperature=vehicle.ev_first_departure_climate_temperature or 21.0,
            temperature_unit=vehicle._ev_first_departure_climate_temperature_unit or 0,
            defrost=vehicle.ev_first_departure_climate_defrost or False,
        )

    async def async_set_schedule_charge_enabled(self, vehicle_id: str, enabled: bool):
        """Toggle scheduled charging on/off."""
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        options = self._build_schedule_options_from_vehicle(vehicle)
        options.charging_enabled = enabled
        await self.async_schedule_charging_and_climate(vehicle_id, options)

    async def async_set_off_peak_charge_only_enabled(
        self, vehicle_id: str, enabled: bool
    ):
        """Toggle off-peak charge only on/off."""
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        options = self._build_schedule_options_from_vehicle(vehicle)
        options.off_peak_charge_only_enabled = enabled
        await self.async_schedule_charging_and_climate(vehicle_id, options)

    async def async_set_departure_enabled(
        self, vehicle_id: str, departure_num: int, enabled: bool
    ):
        """Toggle a departure schedule on/off."""
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        options = self._build_schedule_options_from_vehicle(vehicle)
        if departure_num == 1:
            options.first_departure.enabled = enabled
        else:
            options.second_departure.enabled = enabled
        # reservFlag (charging_enabled) must be 1 for departure slots to take
        # effect. If the vehicle doesn't expose ev_schedule_charge_enabled
        # (None), the builder defaults it to False, causing the API to accept
        # the request but ignore per-slot reservChargeSet.
        if enabled and not options.charging_enabled:
            options.charging_enabled = True
        await self.async_schedule_charging_and_climate(vehicle_id, options)

    async def async_set_departure_climate_enabled(
        self, vehicle_id: str, departure_num: int, enabled: bool
    ):
        """Toggle departure climate on/off."""
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        options = self._build_schedule_options_from_vehicle(vehicle)
        options.climate_enabled = enabled
        await self.async_schedule_charging_and_climate(vehicle_id, options)

    async def async_set_departure_defrost(
        self, vehicle_id: str, departure_num: int, enabled: bool
    ):
        """Toggle departure defrost on/off."""
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        options = self._build_schedule_options_from_vehicle(vehicle)
        options.defrost = enabled
        await self.async_schedule_charging_and_climate(vehicle_id, options)

    async def async_start_hazard_lights(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.start_hazard_lights(vehicle_id),
            "start hazard lights",
        )

    async def async_start_hazard_lights_and_horn(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.start_hazard_lights_and_horn(vehicle_id),
            "start hazard lights and horn",
        )

    async def async_start_valet_mode(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.start_valet_mode(vehicle_id),
            "start valet mode",
        )

    async def async_stop_valet_mode(self, vehicle_id: str):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.stop_valet_mode(vehicle_id),
            "stop valet mode",
        )

    async def async_set_v2l_limit(self, vehicle_id: str, limit: int):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_vehicle_to_load_discharge_limit(
                vehicle_id, limit
            ),
            "set V2L limit",
        )

    async def async_set_windows(
        self, vehicle_id: str, windowOptions: WindowRequestOptions
    ):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_windows_state(vehicle_id, windowOptions),
            "set windows",
        )

    async def async_set_navigation(self, vehicle_id: str, poi_list: list[POIInfo]):
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_navigation(vehicle_id, poi_list),
            "set navigation",
        )

    async def async_open_all_windows(self, vehicle_id: str):
        options = WindowRequestOptions(
            front_left=WINDOW_STATE.OPEN,
            front_right=WINDOW_STATE.OPEN,
            back_left=WINDOW_STATE.OPEN,
            back_right=WINDOW_STATE.OPEN,
        )
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_windows_state(vehicle_id, options),
            "open all windows",
        )

    async def async_close_all_windows(self, vehicle_id: str):
        options = WindowRequestOptions(
            front_left=WINDOW_STATE.CLOSED,
            front_right=WINDOW_STATE.CLOSED,
            back_left=WINDOW_STATE.CLOSED,
            back_right=WINDOW_STATE.CLOSED,
        )
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_windows_state(vehicle_id, options),
            "close all windows",
        )

    async def async_vent_all_windows(self, vehicle_id: str):
        options = WindowRequestOptions(
            front_left=WINDOW_STATE.VENTILATION,
            front_right=WINDOW_STATE.VENTILATION,
            back_left=WINDOW_STATE.VENTILATION,
            back_right=WINDOW_STATE.VENTILATION,
        )
        await self._async_send_action(
            vehicle_id,
            lambda: self.vehicle_manager.set_windows_state(vehicle_id, options),
            "vent all windows",
        )

    async def _async_save_token(self):
        """Persist the latest token into the config entry."""
        new_token = self.vehicle_manager.token.to_dict()
        # Only update if token actually changed
        if new_token and new_token != self.config_entry.data.get(CONF_TOKEN):
            updated_data = {**self.config_entry.data, CONF_TOKEN: new_token}
            self.hass.config_entries.async_update_entry(
                self.config_entry, data=updated_data
            )
