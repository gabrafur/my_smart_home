"""Coordinator for Hyundai / Kia Connect integration."""

from __future__ import annotations

import asyncio
import copy
import datetime as dt
import logging
import threading
import time
import traceback
import types
import uuid
from collections.abc import Callable
from datetime import timedelta
from statistics import median
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
    APIError,
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

BR_CURRENT_APPLICATION_ID = "213a491a-0d7c-4d6a-ac03-a2df127d73b0"
BR_CURRENT_USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 4.1.1; Galaxy Nexus Build/JRO03C) "
    "AppleWebKit/535.19 (KHTML, like Gecko) Chrome/18.0.1025.166 "
    "Mobile Safari/535.19_CCS_APP_AOS"
)
BR_DEVICE_REGISTRATION_PATH = "/spa/notifications/register"
BR_FRESH_DATA_RECHECK_DELAYS_S = (15, 15, 30, 30, 30, 30)
BR_FRESH_DATA_CLOCK_TOLERANCE = timedelta(seconds=60)
TRIP_INFO_BACKGROUND_TIMEOUT_S = 120
TRIP_INFO_RETRY_DELAY_S = 60
TRIP_INFO_MAX_AGE = timedelta(hours=6)
REMOTE_LOCATE_MIN_INTERVAL_S = 60
FUEL_TANK_LITERS = 50.0
MIN_EFFICIENCY_FUEL_PERCENT = 20.0
MAX_EFFICIENCY_FUEL_PERCENT = 80.0
MIN_EFFICIENCY_FUEL_SPAN_PERCENT = 10.0
MIN_EFFICIENCY_SAMPLES = 5
MAX_EFFICIENCY_SAMPLE_GAP = timedelta(minutes=5)
MIN_PLAUSIBLE_KM_PER_L = 3.0
MAX_PLAUSIBLE_KM_PER_L = 25.0


class HyundaiKiaConnectDataUpdateCoordinator(DataUpdateCoordinator):
    """Class to manage fetching data from the API."""

    def __init__(self, hass: HomeAssistant, config_entry: ConfigEntry) -> None:
        """Initialize."""
        self.platforms: set[str] = set()
        self._action_lock = asyncio.Lock()
        self._force_refresh_lock = asyncio.Lock()
        self._br_fresh_data_recheck_tasks: dict[str, asyncio.Task] = {}
        # The Brazilian API exposes one calendar day per request. Keep the
        # dashboard window separate from vehicle.day_trip_info so that the
        # existing entity continues to mean "today".
        self.recent_trip_info: dict[str, dict[str, Any]] = {}
        self.fuel_efficiency: dict[str, dict[str, Any]] = {}
        self.remote_command_status: dict[str, dict[str, Any]] = {}
        self._last_remote_locate_at: dict[str, dt.datetime] = {}
        self._last_trip_refresh_odometer: dict[str, float] = {}
        self._trip_history_initialized: set[str] = set()
        self._trip_refresh_tasks: dict[str, asyncio.Task] = {}
        self._last_trip_refresh_success_at: dict[str, dt.datetime] = {}
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
        self._install_br_client_compatibility()
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
            config_entry=config_entry,
            name=DOMAIN,
            # O polling do coordinator publica o cache Bluelink no Home
            # Assistant. Ele nunca agenda um wake real; esse papel pertence ao
            # coordenador persistente do Node-RED.
            update_interval=timedelta(seconds=self.scan_interval),
        )
        _LOGGER.debug(
            "%s - Polling configured: scan_interval=%ds, "
            "force_refresh_interval=%ds, update_interval=%ds, "
            "no_force_refresh_hours=%d-%d",
            DOMAIN,
            self.scan_interval,
            self.force_refresh_interval,
            self.scan_interval,
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
        except AuthenticationError as auth_error:
            # The BR backend can invalidate a server-side session or client
            # identifier transiently (observed as 401/4002). Keep the config
            # entry loaded and retry slowly so entities can recover without a
            # reload; other regions retain the upstream re-auth behavior.
            if type(self.vehicle_manager.api).__name__ == "HyundaiBlueLinkApiBR":
                raise UpdateFailed(
                    "Bluelink authentication session unavailable; will retry",
                    retry_after=15 * 60,
                ) from auth_error
            raise ConfigEntryAuthFailed(auth_error) from auth_error
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
        try:
            await self.hass.async_add_executor_job(
                self.vehicle_manager.update_all_vehicles_with_cached_state
            )
        except Exception as err:
            _LOGGER.exception("Cached vehicle update failed")
            raise UpdateFailed(
                "Error reading Hyundai/Kia Connect cached state; will retry",
                retry_after=15 * 60,
            ) from err

        await self._async_refresh_trip_info_on_new_distance()
        await self._async_save_token()

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
                # The coordinator's first refresh runs before Home Assistant
                # creates any Kia entities. The BR /tripinfo endpoint can take
                # minutes or stall independently of vehicle status, so never
                # make entity availability depend on this optional history.
                # Record the odometer baseline and load today/yesterday in a
                # managed background task. Entity setup remains independent
                # from /tripinfo latency, while the dashboard is populated
                # after every integration start.
                self._trip_history_initialized.add(vehicle_id)
                self._schedule_trip_info_refresh(vehicle_id, "startup")
                continue
            moved = previous is not None and current > previous + 0.05
            last_success = self._last_trip_refresh_success_at.get(vehicle_id)
            periodic_due = (
                last_success is None
                or dt_util.utcnow() - last_success >= TRIP_INFO_MAX_AGE
            )
            if not moved and not periodic_due:
                continue
            if moved:
                _LOGGER.info(
                    "CRETA_MOVEMENT_DETECTED odometer_delta_km=%.2f; "
                    "scheduling trip history refresh",
                    current - previous,
                )
            self._schedule_trip_info_refresh(
                vehicle_id,
                "odometer_movement" if moved else "periodic_fallback",
            )

    def _schedule_trip_info_refresh(self, vehicle_id: str, reason: str) -> None:
        """Schedule a deduplicated trip refresh without blocking status data."""
        current = self._trip_refresh_tasks.get(vehicle_id)
        if current is not None and not current.done():
            return
        task = self.hass.async_create_background_task(
            self._async_refresh_trip_info_with_retry(vehicle_id, reason),
            f"kia_uvo trip info refresh ({reason})",
        )
        self._trip_refresh_tasks[vehicle_id] = task

    async def _async_refresh_trip_info_with_retry(
        self, vehicle_id: str, reason: str
    ) -> None:
        """Refresh trip history in the background with one bounded retry."""
        try:
            for attempt in (1, 2):
                if attempt > 1:
                    await asyncio.sleep(TRIP_INFO_RETRY_DELAY_S)
                try:
                    async with asyncio.timeout(TRIP_INFO_BACKGROUND_TIMEOUT_S):
                        await self.async_refresh_day_trip_info(vehicle_id)
                    self._last_trip_refresh_success_at[vehicle_id] = dt_util.utcnow()
                    _LOGGER.info(
                        "CRETA_TRIP_BACKGROUND_REFRESHED reason=%s attempt=%d",
                        reason,
                        attempt,
                    )
                    return
                except TimeoutError:
                    _LOGGER.warning(
                        "CRETA_TRIP_BACKGROUND_TIMEOUT reason=%s attempt=%d",
                        reason,
                        attempt,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as err:
                    _LOGGER.warning(
                        "CRETA_TRIP_BACKGROUND_FAILED reason=%s attempt=%d: %s",
                        reason,
                        attempt,
                        err,
                    )
        finally:
            self._trip_refresh_tasks.pop(vehicle_id, None)

    async def async_update_all(self) -> None:
        """Update vehicle data."""
        await self.async_check_and_refresh_token()
        await self.hass.async_add_executor_job(
            self.vehicle_manager.update_all_vehicles_with_cached_state
        )
        self.async_set_updated_data(self.data)

    async def async_force_update_all(self) -> None:
        """Force refresh vehicle data and update it."""
        if self._force_refresh_lock.locked():
            raise HomeAssistantError(
                "A vehicle refresh is already in progress; request coalesced"
            )
        async with self._force_refresh_lock:
            await self.async_check_and_refresh_token()
            await self.hass.async_add_executor_job(
                self.vehicle_manager.force_refresh_all_vehicles_states
            )
            self.async_set_updated_data(self.data)

    async def async_force_refresh_vehicle(self, vehicle_id: str) -> None:
        """Force refresh a single vehicle's state."""
        if self._force_refresh_lock.locked():
            raise HomeAssistantError(
                "A vehicle refresh is already in progress; request coalesced"
            )

        async with self._force_refresh_lock:
            api = self.vehicle_manager.api
            try:
                await self.async_check_and_refresh_token()
            except AuthenticationError as err:
                if type(api).__name__ != "HyundaiBlueLinkApiBR":
                    raise
                # A transient BR sign-in failure is not a programming error.
                # Node-RED still requires newer entity timestamps before it
                # declares success, so preserving the cache safely drives the
                # same retry/backoff without an unhandled WebSocket error.
                _LOGGER.warning(
                    "CRETA_REFRESH_AUTH_UNAVAILABLE keeping cached state: %s",
                    err,
                )
                self.async_set_updated_data(self.data)
                return
            vehicle = self.vehicle_manager.vehicles.get(vehicle_id)
            baseline_updated_at = getattr(vehicle, "last_updated_at", None)
            requested_at = dt.datetime.now(dt.UTC)
            _LOGGER.info("CRETA_REFRESH_REQUESTED source=force_refresh_button")
            try:
                await self.hass.async_add_executor_job(
                    self.vehicle_manager.force_refresh_vehicle_state, vehicle_id
                )
            except Exception as err:
                no_fresh_data = (
                    type(api).__name__ == "HyundaiBlueLinkApiBR"
                    and isinstance(err, APIError)
                    and "did not return fresh data in time" in str(err)
                )
                try:
                    await self.hass.async_add_executor_job(
                        self.vehicle_manager.update_vehicle_with_cached_state,
                        vehicle_id,
                    )
                except Exception:
                    _LOGGER.exception(
                        "Cached vehicle read after force-refresh failure also failed"
                    )
                self.async_set_updated_data(self.data)
                if no_fresh_data:
                    # The BR wake is asynchronous and this vehicle has been
                    # observed publishing more than two minutes after the
                    # library's fixed 25-second wait. Keep the service call
                    # bounded, then re-read /latest in the background without
                    # issuing another wake. Node-RED still requires the
                    # semantic vehicle timestamp before declaring success.
                    self._schedule_br_fresh_data_recheck(
                        vehicle_id,
                        baseline_updated_at,
                        requested_at,
                    )
                    _LOGGER.warning(
                        "CRETA_REFRESH_NO_FRESH_DATA vehicle_id=%s; "
                        "scheduled bounded cached rechecks: %s",
                        vehicle_id,
                        err,
                    )
                    return
                _LOGGER.warning(
                    "CRETA_REFRESH_FAILED vehicle_id=%s; keeping cached state: %s",
                    vehicle_id,
                    err,
                )
                raise HomeAssistantError(
                    f"Vehicle refresh failed: {type(err).__name__}"
                ) from err
            self.async_set_updated_data(self.data)

    @staticmethod
    def _br_timestamp_is_fresh(
        current: dt.datetime | None,
        baseline: dt.datetime | None,
        requested_at: dt.datetime,
    ) -> bool:
        """Return whether a BR timestamp proves data from the current wake."""

        def as_utc(value: dt.datetime | None) -> dt.datetime | None:
            if not isinstance(value, dt.datetime):
                return None
            if value.tzinfo is None:
                return value.replace(tzinfo=dt.UTC)
            return value.astimezone(dt.UTC)

        current_utc = as_utc(current)
        baseline_utc = as_utc(baseline)
        requested_utc = as_utc(requested_at)
        if current_utc is None or requested_utc is None:
            return False
        return (
            (baseline_utc is None or current_utc > baseline_utc)
            and current_utc >= requested_utc - BR_FRESH_DATA_CLOCK_TOLERANCE
        )

    def _schedule_br_fresh_data_recheck(
        self,
        vehicle_id: str,
        baseline_updated_at: dt.datetime | None,
        requested_at: dt.datetime,
    ) -> None:
        """Schedule bounded cached reads after a slow asynchronous BR wake."""
        current = self._br_fresh_data_recheck_tasks.get(vehicle_id)
        if current is not None and not current.done():
            current.cancel()
        task = self.hass.async_create_background_task(
            self._async_recheck_br_fresh_data(
                vehicle_id,
                baseline_updated_at,
                requested_at,
            ),
            "kia_uvo BR fresh-data recheck",
        )
        self._br_fresh_data_recheck_tasks[vehicle_id] = task

    async def _async_recheck_br_fresh_data(
        self,
        vehicle_id: str,
        baseline_updated_at: dt.datetime | None,
        requested_at: dt.datetime,
    ) -> None:
        """Poll only the cached endpoint until the delayed wake appears."""
        try:
            for attempt, delay_s in enumerate(
                BR_FRESH_DATA_RECHECK_DELAYS_S,
                start=1,
            ):
                await asyncio.sleep(delay_s)
                if self._force_refresh_lock.locked():
                    continue
                try:
                    async with self._force_refresh_lock:
                        await self.hass.async_add_executor_job(
                            self.vehicle_manager.update_vehicle_with_cached_state,
                            vehicle_id,
                        )
                except asyncio.CancelledError:
                    raise
                except Exception as err:
                    _LOGGER.warning(
                        "CRETA_REFRESH_RECHECK_FAILED attempt=%d error=%s",
                        attempt,
                        type(err).__name__,
                    )
                    continue

                vehicle = self.vehicle_manager.vehicles.get(vehicle_id)
                current_updated_at = getattr(vehicle, "last_updated_at", None)
                if not self._br_timestamp_is_fresh(
                    current_updated_at,
                    baseline_updated_at,
                    requested_at,
                ):
                    continue
                self.async_set_updated_data(self.data)
                _LOGGER.info(
                    "CRETA_REFRESH_DELAYED_DATA_RECEIVED attempt=%d",
                    attempt,
                )
                return
            _LOGGER.warning(
                "CRETA_REFRESH_RECHECK_EXHAUSTED no fresh semantic timestamp"
            )
        finally:
            current = self._br_fresh_data_recheck_tasks.get(vehicle_id)
            if current is asyncio.current_task():
                self._br_fresh_data_recheck_tasks.pop(vehicle_id, None)

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
        """Estimate km/L from the vehicle's range model over Recorder history.

        Fuel level is an integer, non-linear gauge. A drop around a short trip
        cannot be converted reliably to liters and can also include driving
        outside that trip. Instead, use the median implied efficiency from
        range and fuel readings captured by the same status update, excluding
        the tank extremes where reserve/full-gauge behavior is least linear.
        """
        vehicle = self.vehicle_manager.vehicles[vehicle_id]
        registry = er.async_get(self.hass)
        fuel_entity_id = registry.async_get_entity_id(
            "sensor", DOMAIN, f"{DOMAIN}_{vehicle.id}_fuel_level"
        )
        range_entity_id = registry.async_get_entity_id(
            "sensor", DOMAIN, f"{DOMAIN}_{vehicle.id}__fuel_driving_range"
        )
        recent_trip_entity_id = registry.async_get_entity_id(
            "sensor", DOMAIN, f"{DOMAIN}-recent-trip-info-{vehicle.id}"
        )
        if not fuel_entity_id or not range_entity_id:
            return

        recorder = get_instance(self.hass)
        lookback_days = max(1, recorder.keep_days)
        start = dt_util.utcnow() - timedelta(days=lookback_days)
        entity_ids = [fuel_entity_id, range_entity_id]
        if recent_trip_entity_id:
            entity_ids.append(recent_trip_entity_id)
        states = await recorder.async_add_executor_job(
            lambda: history.get_significant_states(
                self.hass,
                start,
                entity_ids=entity_ids,
                no_attributes=False,
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
        range_readings = numeric(range_entity_id)
        # /tripinfo returns one day per request and is rate-limited. Each
        # current two-day response is already recorded with full attributes,
        # so merge those retained snapshots instead of issuing one API call
        # per historical day. This automatically follows Recorder retention.
        trips_by_key: dict[tuple[str | None, str | None], dict[str, Any]] = {}
        if recent_trip_entity_id:
            for state in states.get(recent_trip_entity_id, []):
                for trip in state.attributes.get("trips", []):
                    if not isinstance(trip, dict):
                        continue
                    key = (trip.get("date"), trip.get("start_time") or trip.get("started_at"))
                    trips_by_key[key] = dict(trip)
        for trip in self.recent_trip_info[vehicle_id]["trips"]:
            key = (trip.get("date"), trip.get("start_time") or trip.get("started_at"))
            # Keep current objects by reference for the recent-trip sensor.
            # Recorder snapshots remain copied above because they are
            # historical input and must not be mutated.
            trips_by_key[key] = trip
        available_trips = sorted(
            trips_by_key.values(),
            key=lambda trip: (trip.get("date") or "", trip.get("start_time") or ""),
            reverse=True,
        )
        for trip in available_trips:
            # Recorder can retain estimates produced by an older method.
            # Never let those stale values leak back into the dashboard.
            trip.pop("estimated_liters", None)
            trip.pop("estimated_km_per_l", None)
            trip.pop("consumption_source", None)
        observations: list[tuple[dt.datetime, float, float, float]] = []
        for fuel_at, fuel_percent in fuel_readings:
            if not MIN_EFFICIENCY_FUEL_PERCENT <= fuel_percent <= MAX_EFFICIENCY_FUEL_PERCENT:
                continue
            nearest_range = min(
                range_readings,
                key=lambda item: abs(item[0] - fuel_at),
                default=None,
            )
            if (
                nearest_range is None
                or abs(nearest_range[0] - fuel_at) > MAX_EFFICIENCY_SAMPLE_GAP
            ):
                continue
            remaining_liters = fuel_percent * FUEL_TANK_LITERS / 100
            km_per_liter = nearest_range[1] / remaining_liters
            if not MIN_PLAUSIBLE_KM_PER_L <= km_per_liter <= MAX_PLAUSIBLE_KM_PER_L:
                continue
            observations.append(
                (fuel_at, fuel_percent, nearest_range[1], km_per_liter)
            )

        fuel_span = (
            max(item[1] for item in observations) - min(item[1] for item in observations)
            if observations
            else 0.0
        )
        data_sufficient = (
            len(observations) >= MIN_EFFICIENCY_SAMPLES
            and fuel_span >= MIN_EFFICIENCY_FUEL_SPAN_PERCENT
        )
        average = (
            round(median(item[3] for item in observations), 1)
            if data_sufficient
            else None
        )
        modeled_trips: list[tuple[dict[str, Any], float, float]] = []
        if average is not None:
            for trip in self.recent_trip_info[vehicle_id]["trips"]:
                try:
                    distance = float(trip.get("distance") or 0)
                    drive_time = float(trip.get("drive_time_min") or 0)
                    idle_time = float(trip.get("idle_time_min") or 0)
                except (TypeError, ValueError):
                    continue
                total_time = drive_time + idle_time
                if distance <= 0 or drive_time <= 0 or total_time <= 0:
                    continue
                moving_fraction = drive_time / total_time
                modeled_trips.append((trip, distance, moving_fraction))

        # /tripinfo does not report liters. Allocate the fuel implied by the
        # window average across the currently displayed trips according to
        # distance and idle share. The allocation is normalized so their
        # distance-weighted aggregate remains equal to the window estimate.
        if modeled_trips:
            total_distance = sum(item[1] for item in modeled_trips)
            idle_adjusted_distance = sum(
                distance / moving_fraction
                for _trip, distance, moving_fraction in modeled_trips
            )
            moving_efficiency = average * idle_adjusted_distance / total_distance
            for trip, distance, moving_fraction in modeled_trips:
                trip_efficiency = moving_efficiency * moving_fraction
                estimated_liters = distance / trip_efficiency
                trip["estimated_liters"] = round(estimated_liters, 2)
                trip["estimated_km_per_l"] = round(trip_efficiency, 1)
                trip["consumption_source"] = (
                    "modelo calibrado pela média da janela e proporção de marcha lenta"
                )
        recent_info = self.recent_trip_info[vehicle_id]
        available_dates = sorted(
            {
                date
                for date in (
                    *(trip.get("date") for trip in available_trips),
                    recent_info.get("period_start"),
                    recent_info.get("period_end"),
                )
                if date
            }
        )
        self.fuel_efficiency[vehicle_id] = {
            "km_per_l": average,
            "data_sufficient": data_sufficient,
            "tank_liters": FUEL_TANK_LITERS,
            "period_start": available_dates[0] if available_dates else recent_info.get("period_start"),
            "period_end": available_dates[-1] if available_dates else recent_info.get("period_end"),
            "recorder_search_start": start.isoformat(),
            "recorder_search_end": dt_util.utcnow().isoformat(),
            "search_window_days": lookback_days,
            "sample_window_start": (
                min(item[0] for item in observations).isoformat()
                if observations
                else None
            ),
            "sample_window_end": (
                max(item[0] for item in observations).isoformat()
                if observations
                else None
            ),
            "trips_available": len(available_trips),
            "fuel_samples_available": len(fuel_readings),
            "range_samples_available": len(range_readings),
            "samples_used": len(observations),
            "trips_modeled": len(modeled_trips),
            "fuel_span_percent": round(fuel_span, 1),
            "minimum_fuel_percent": MIN_EFFICIENCY_FUEL_PERCENT,
            "maximum_fuel_percent": MAX_EFFICIENCY_FUEL_PERCENT,
            "maximum_sample_gap_minutes": (
                MAX_EFFICIENCY_SAMPLE_GAP.total_seconds() / 60
            ),
            "method": (
                "Mediana da autonomia restante ÷ combustível estimado no tanque; "
                "amostras entre 20% e 80%"
            ),
        }
        self.recent_trip_info[vehicle_id]["fuel_efficiency"] = self.fuel_efficiency[vehicle_id]

    def _install_br_client_compatibility(self) -> None:
        """Follow the current Brazilian app device-registration contract.

        The BR backend invalidated the fixed device id used by API 4.26.5
        after the official Android app moved to 1.0.20. Every authenticated
        request then fails with resCode 4002, including the cached status call,
        so all Home Assistant entities become unavailable.

        The current app first registers a local UUID/push token and uses the
        server-issued deviceId on subsequent requests. Intercept only that
        explicit backend response, register once under a lock, update the
        persisted Token object and retry the original request once.
        """
        api = self.vehicle_manager.api
        if type(api).__name__ != "HyundaiBlueLinkApiBR":
            return

        api.ccsp_application_id = BR_CURRENT_APPLICATION_ID
        api.api_headers["User-Agent"] = BR_CURRENT_USER_AGENT
        registration_lock = threading.Lock()
        original_request = api.session.request
        coordinator = self

        def _is_invalid_device(response) -> bool:
            if response.status_code != 400:
                return False
            try:
                payload = response.json()
            except ValueError:
                return False
            return isinstance(payload, dict) and payload.get("resCode") == "4002"

        def _register_device() -> str:
            headers = dict(api.api_headers)
            headers.update(
                {
                    "Authorization": "",
                    "Stamp": "false",
                    "ccsp-application-id": BR_CURRENT_APPLICATION_ID,
                    "ccsp-device-id": "",
                    "ccsp-service-id": api.ccsp_service_id,
                }
            )
            payload = {
                "uuid": str(uuid.uuid4()),
                "pushRegId": f"dummy-push-{time.time_ns() // 1_000_000}",
                "pushType": "GCM",
            }
            response = original_request(
                "POST",
                api._build_api_url(BR_DEVICE_REGISTRATION_PATH),
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            result = response.json()
            device_id = (
                result.get("resMsg", {}).get("deviceId")
                if isinstance(result, dict)
                and isinstance(result.get("resMsg"), dict)
                else None
            )
            if (
                not isinstance(result, dict)
                or result.get("retCode") != "S"
                or not device_id
            ):
                raise RuntimeError(
                    "Brazilian Hyundai device registration returned no deviceId"
                )
            return device_id

        def _request_with_device_recovery(session_self, method, url, **kwargs):
            del session_self
            response = original_request(method, url, **kwargs)
            if (
                BR_DEVICE_REGISTRATION_PATH in url
                or not _is_invalid_device(response)
            ):
                return response

            headers = dict(kwargs.get("headers") or {})
            rejected_device_id = headers.get("ccsp-device-id")
            with registration_lock:
                token = coordinator.vehicle_manager.token
                if token is None:
                    return response
                if token.device_id and token.device_id != rejected_device_id:
                    device_id = token.device_id
                else:
                    device_id = _register_device()
                    token.device_id = device_id
                    _LOGGER.warning(
                        "CRETA_DEVICE_ID_RECOVERED res_code=4002; "
                        "registered current Bluelink client"
                    )
                    if hasattr(coordinator, "hass"):
                        coordinator.hass.loop.call_soon_threadsafe(
                            coordinator._save_token_if_changed
                        )

            retry_kwargs = dict(kwargs)
            headers["ccsp-application-id"] = BR_CURRENT_APPLICATION_ID
            headers["ccsp-device-id"] = device_id
            retry_kwargs["headers"] = headers
            if isinstance(retry_kwargs.get("json"), dict):
                request_payload = dict(retry_kwargs["json"])
                for key in ("deviceId", "deviceID"):
                    if key in request_payload:
                        request_payload[key] = device_id
                retry_kwargs["json"] = request_payload
            return original_request(method, url, **retry_kwargs)

        api.session.request = types.MethodType(
            _request_with_device_recovery, api.session
        )

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
            async with self._force_refresh_lock:
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
        self._save_token_if_changed()

    def _save_token_if_changed(self) -> None:
        """Persist a changed token; must run on the Home Assistant loop."""
        new_token = self.vehicle_manager.token.to_dict()
        # Only update if token actually changed
        if new_token and new_token != self.config_entry.data.get(CONF_TOKEN):
            updated_data = {**self.config_entry.data, CONF_TOKEN: new_token}
            self.hass.config_entries.async_update_entry(
                self.config_entry, data=updated_data
            )
