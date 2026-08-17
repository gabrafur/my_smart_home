"""Coordinator for Hyundai / Kia Connect integration."""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import logging
import traceback
import types
from collections.abc import Callable
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.components.recorder import get_instance, history
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
    OffPeakChargingMode,
)

_LOGGER = logging.getLogger(__name__)

# Piso de seguranca entre dois wakes reais. Acordar o carro puxa a bateria de
# 12 V e conta contra o rate limit da Hyundai - e' por isso que o options flow
# do kia_uvo trava o force interval proprio da integracao em 90 min. Quem
# aperta button.*_force_refresh direto (o flow iluminacao_seguranca no
# Node-RED) contorna esse piso, entao mantemos um aqui, que ninguem contorna.
BR_WAKE_MIN_INTERVAL_S = 15 * 60
REMOTE_LOCATE_MIN_INTERVAL_S = 60
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
        self.remote_command_status: dict[str, dict[str, Any]] = {}
        self._last_remote_locate_at: dict[str, dt.datetime] = {}
        self._last_trip_refresh_odometer: dict[str, float] = {}
        self._trip_history_initialized: set[str] = set()
        self._br_last_button_wake_at: dt.datetime | None = None

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
        self._install_br_parser_compatibility()
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
                        "Force update failed, falling back to cached vehicle state"
                    )
                    await self.hass.async_add_executor_job(
                        self.vehicle_manager.update_all_vehicles_with_cached_state
                    )
                except Exception:
                    _LOGGER.exception("Cached vehicle update failed")
                    raise UpdateFailed(
                        "Error communicating with Hyundai/Kia Connect; will retry",
                        retry_after=60,
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
            if vehicle_id not in self._trip_history_initialized:
                self._trip_history_initialized.add(vehicle_id)
                try:
                    await self.async_refresh_day_trip_info(vehicle_id)
                except Exception:
                    _LOGGER.exception(
                        "CRETA_API_ERROR trip history initialization failed"
                    )
                continue
            if previous is None or current <= previous + 0.05:
                continue
            _LOGGER.info(
                "CRETA_MOVEMENT_DETECTED odometer_delta_km=%.2f; "
                "refreshing trip history",
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
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        api = self.vehicle_manager.api
        now = dt_util.utcnow()
        recent_candidates = [self._br_last_button_wake_at, vehicle.last_updated_at]
        recent = max(
            (
                timestamp
                for timestamp in recent_candidates
                if timestamp is not None and timestamp.tzinfo is not None
            ),
            default=None,
        )
        cooldown_active = (
            type(api).__name__ == "HyundaiBlueLinkApiBR"
            and recent is not None
            and (now - dt_util.as_utc(recent)).total_seconds()
            < BR_WAKE_MIN_INTERVAL_S
        )
        if cooldown_active:
            age = (now - dt_util.as_utc(recent)).total_seconds()
            _LOGGER.info(
                "CRETA_REFRESH_SUPPRESSED cooldown_active=true age_seconds=%.0f "
                "minimum_seconds=%d",
                age,
                BR_WAKE_MIN_INTERVAL_S,
            )
            await self.hass.async_add_executor_job(
                self.vehicle_manager.update_vehicle_with_cached_state, vehicle_id
            )
        else:
            _LOGGER.info("CRETA_REFRESH_REQUESTED source=force_refresh_button")
            if type(api).__name__ == "HyundaiBlueLinkApiBR":
                self._br_last_button_wake_at = now
            try:
                await self.hass.async_add_executor_job(
                    self.vehicle_manager.force_refresh_vehicle_state, vehicle_id
                )
            except Exception as err:
                # The BR backend can accept the wake request but fail to return
                # fresh telemetry before its deadline.  This is a transient
                # vehicle/API condition; do not turn a manual refresh into an
                # unhandled WebSocket error or discard the last known state.
                _LOGGER.warning(
                    "CRETA_REFRESH_TIMEOUT vehicle_id=%s; keeping cached state: %s",
                    vehicle_id,
                    err,
                )
                await self.hass.async_add_executor_job(
                    self.vehicle_manager.update_vehicle_with_cached_state, vehicle_id
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
        _LOGGER.info(
            "CRETA_TRIP_UPDATED days=%d trips=%d total_distance_km=%.1f",
            len(days),
            len(self.recent_trip_info[vehicle_id]["trips"]),
            self.recent_trip_info[vehicle_id]["total_distance"],
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
        states = await get_instance(self.hass).async_add_executor_job(
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
        considered_trips: list[dict[str, Any]] = []
        used_fuel_samples: set[dt.datetime] = set()
        used_odometer_samples: set[dt.datetime] = set()
        for trip in self.recent_trip_info[vehicle_id]["trips"]:
            if not trip["started_at"] or trip["duration_min"] is None:
                continue
            # tripinfo returns the vehicle's local wall-clock time. Recorder
            # timestamps are UTC, so convert via Home Assistant's configured
            # timezone before comparing the two histories.
            local_tz = (
                dt_util.get_time_zone(self.hass.config.time_zone)
                or dt_util.DEFAULT_TIME_ZONE
            )
            started = dt_util.as_utc(
                dt.datetime.fromisoformat(trip["started_at"]).replace(tzinfo=local_tz)
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
            considered_trips.append(
                {
                    "started_at": started.isoformat(),
                    "ended_at": ended.isoformat(),
                    "distance_km": round(trip_distance, 1),
                    "estimated_liters": round(liters, 2),
                }
            )
            used_fuel_samples.update((before_fuel[0], after_fuel[0]))
            used_odometer_samples.update((before_odo[0], after_odo[0]))
            estimated_liters += liters
            estimated_distance += trip_distance

        average = round(estimated_distance / estimated_liters, 1) if estimated_liters else None
        recent_info = self.recent_trip_info[vehicle_id]
        self.fuel_efficiency[vehicle_id] = {
            "km_per_l": average,
            "data_sufficient": average is not None,
            "estimated_distance": round(estimated_distance, 1),
            "estimated_liters": round(estimated_liters, 2),
            "tank_liters": FUEL_TANK_LITERS,
            "period_start": recent_info.get("period_start"),
            "period_end": recent_info.get("period_end"),
            "recorder_search_start": start.isoformat(),
            "recorder_search_end": dt_util.utcnow().isoformat(),
            "trip_window_start": (
                min(item["started_at"] for item in considered_trips)
                if considered_trips
                else None
            ),
            "trip_window_end": (
                max(item["ended_at"] for item in considered_trips)
                if considered_trips
                else None
            ),
            "trips_available": len(recent_info.get("trips", [])),
            "trips_considered": len(considered_trips),
            "fuel_samples_available": len(fuel_readings),
            "fuel_samples_used": len(used_fuel_samples),
            "odometer_samples_available": len(odometer_readings),
            "odometer_samples_used": len(used_odometer_samples),
            "minimum_fuel_drop_percent": MIN_FUEL_DROP_PERCENT,
            "maximum_sample_gap_hours": MAX_READING_GAP.total_seconds() / 3600,
            "method": "Estimativa: distância da viagem ÷ (queda percentual × 50 L)",
        }
        self.recent_trip_info[vehicle_id]["fuel_efficiency"] = self.fuel_efficiency[vehicle_id]

    def _install_br_parser_compatibility(self) -> None:
        """Preserve local BR parsing compatibility on top of API 4.26.5.

        API 4.26.5 natively handles the Creta's CCS2 endpoint, parser, wake and
        UTC timestamp. The remaining local workaround is intentionally narrow:
        tolerate the intermittent invalid DTE unit and preserve the historical
        fuel-range entity alias used by this installation.
        """
        api = self.vehicle_manager.api
        if type(api).__name__ != "HyundaiBlueLinkApiBR":
            return
        original = type(api)._update_vehicle_properties_ccs2

        def _parse_ccs2(api_self, vehicle, state):
            parser_state = copy.deepcopy(state)
            dte = (
                parser_state.get("Drivetrain", {})
                .get("FuelSystem", {})
                .get("DTE", {})
            )
            if dte.get("Unit") not in (0, 1, None):
                _LOGGER.warning(
                    "CRETA_DATA_ANOMALY invalid_dte_unit=%s normalized_to=km",
                    dte["Unit"],
                )
                dte["Unit"] = 1
            reservation = parser_state.get("Green", {}).get("Reservation", {})
            off_peak = reservation.get("OffPeakTime")
            if off_peak == {"Mode": 1}:
                # BR ICE vehicles expose this reserved stub. Treating it as a
                # real EV schedule creates phantom 00:00 time entities and a
                # warning on every poll in API 4.26.5.
                reservation.pop("OffPeakTime")
            original(api_self, vehicle, parser_state)
            # BR sends Location.TimeStamp in the same UTC wall clock used by
            # Vehicle.Date. ApiImplType1 currently labels the components with
            # the regional timezone, shifting this entity three hours into the
            # future when Home Assistant serializes it as UTC.
            location = parser_state.get("Location", {})
            timestamp = location.get("TimeStamp")
            coordinates = location.get("GeoCoord", {})
            if timestamp and all(
                timestamp.get(key) is not None
                for key in ("Year", "Mon", "Day", "Hour", "Min", "Sec")
            ):
                try:
                    location_updated_at = dt.datetime(
                        year=int(timestamp["Year"]),
                        month=int(timestamp["Mon"]),
                        day=int(timestamp["Day"]),
                        hour=int(timestamp["Hour"]),
                        minute=int(timestamp["Min"]),
                        second=int(timestamp["Sec"]),
                        tzinfo=dt.UTC,
                    )
                    vehicle.location = (
                        coordinates.get("Latitude"),
                        coordinates.get("Longitude"),
                        location_updated_at,
                    )
                except (TypeError, ValueError):
                    _LOGGER.warning(
                        "CRETA_DATA_ANOMALY invalid_location_timestamp"
                    )
            if vehicle.total_driving_range is not None:
                vehicle.fuel_driving_range = (
                    vehicle.total_driving_range,
                    vehicle.total_driving_range_unit,
                )
        api._update_vehicle_properties_ccs2 = types.MethodType(_parse_ccs2, api)

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
        raise_confirmation_error: bool = False,
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
            except Exception as err:
                _LOGGER.exception(
                    "Action '%s' was sent but confirmation polling failed",
                    error_label,
                )
                if raise_confirmation_error:
                    raise HomeAssistantError(
                        f"Vehicle accepted the {error_label} request, but "
                        "confirmation polling failed."
                    ) from err
            return action_id

    def _set_remote_command_status(
        self, vehicle_id: str, state: str, **attributes: Any
    ) -> None:
        """Publish non-sensitive feedback for a remote vehicle command."""
        previous = self.remote_command_status.get(vehicle_id, {})
        self.remote_command_status[vehicle_id] = {
            **previous,
            "state": state,
            "updated_at": dt_util.utcnow().isoformat(),
            **attributes,
        }
        self.async_set_updated_data(self.data)

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

    async def async_set_off_peak_charging(
        self,
        vehicle_id: str,
        *,
        mode: OffPeakChargingMode | None = None,
        start: dt.time | None = None,
        end: dt.time | None = None,
    ) -> None:
        """Set the off-peak charging mode and/or window."""
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        options = self._build_schedule_options_from_vehicle(vehicle)
        if mode is not None:
            if mode is OffPeakChargingMode.OFF:
                options.charging_enabled = False
            elif mode is OffPeakChargingMode.TIME:
                options.charging_enabled = True
                options.off_peak_charge_only_enabled = True
            elif mode is OffPeakChargingMode.TARGET:
                options.charging_enabled = True
                options.off_peak_charge_only_enabled = False
        if start is not None:
            options.off_peak_start_time = start
        if end is not None:
            options.off_peak_end_time = end
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
        now = dt_util.utcnow()
        previous = self._last_remote_locate_at.get(vehicle_id)
        if previous and (now - previous).total_seconds() < REMOTE_LOCATE_MIN_INTERVAL_S:
            remaining = max(
                1,
                round(
                    REMOTE_LOCATE_MIN_INTERVAL_S - (now - previous).total_seconds()
                ),
            )
            self._set_remote_command_status(
                vehicle_id,
                "cooldown",
                command="hazard_lights_and_horn",
                duration_seconds=30,
                retry_after_seconds=remaining,
                failure_stage="local_rate_limit",
            )
            _LOGGER.warning(
                "CRETA_REMOTE_LOCATE_FAILED stage=local_rate_limit retry_after_s=%d",
                remaining,
            )
            raise HomeAssistantError(
                f"Vehicle locate was requested recently. Try again in {remaining}s."
            )

        self._last_remote_locate_at[vehicle_id] = now
        self._set_remote_command_status(
            vehicle_id,
            "requesting",
            command="hazard_lights_and_horn",
            duration_seconds=30,
            requested_at=now.isoformat(),
            retry_after_seconds=None,
            failure_stage=None,
        )
        _LOGGER.info("CRETA_REMOTE_LOCATE_REQUESTED command=hazard_lights_and_horn")
        try:
            await self._async_send_action(
                vehicle_id,
                lambda: self.vehicle_manager.start_hazard_lights_and_horn(vehicle_id),
                "start hazard lights and horn",
                raise_confirmation_error=True,
            )
        except Exception as err:
            self._set_remote_command_status(
                vehicle_id,
                "failed",
                command="hazard_lights_and_horn",
                duration_seconds=30,
                failed_at=dt_util.utcnow().isoformat(),
                failure_stage="request_or_confirmation",
                error_type=type(err).__name__,
            )
            _LOGGER.exception(
                "CRETA_REMOTE_LOCATE_FAILED stage=request_or_confirmation"
            )
            raise

        self._set_remote_command_status(
            vehicle_id,
            "accepted",
            command="hazard_lights_and_horn",
            duration_seconds=30,
            accepted_at=dt_util.utcnow().isoformat(),
            failure_stage=None,
            error_type=None,
        )
        _LOGGER.info("CRETA_REMOTE_LOCATE_ACCEPTED command=hazard_lights_and_horn")

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
