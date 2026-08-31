"""Regression tests for the vehicle_primary range-based consumption estimate."""

from __future__ import annotations

import asyncio
import datetime as dt
import importlib.util
import sys
import unittest
from pathlib import Path
from types import MethodType, ModuleType, SimpleNamespace
from unittest.mock import patch


def _module(name: str, **attributes):
    module = ModuleType(name)
    module.__dict__.update(attributes)
    sys.modules[name] = module
    return module


def _load_coordinator_without_home_assistant():
    """Load the vendored coordinator with the smallest deterministic API surface."""
    package_root = Path(__file__).resolve().parents[1] / "custom_components" / "kia_uvo"
    _module("homeassistant", __path__=[])
    _module("homeassistant.components", __path__=[])
    history = _module(
        "homeassistant.components.recorder.history",
        get_significant_states=lambda *_args, **_kwargs: {},
    )
    _module("homeassistant.components.recorder", get_instance=None, history=history)
    _module("homeassistant.config_entries", ConfigEntry=type("ConfigEntry", (), {}))
    _module(
        "homeassistant.const",
        CONF_PASSWORD="password",
        CONF_PIN="pin",
        CONF_REGION="region",
        CONF_SCAN_INTERVAL="scan_interval",
        CONF_USERNAME="username",
    )
    _module("homeassistant.core", HomeAssistant=type("HomeAssistant", (), {}))
    _module(
        "homeassistant.exceptions",
        ConfigEntryAuthFailed=type("ConfigEntryAuthFailed", (Exception,), {}),
        HomeAssistantError=type("HomeAssistantError", (Exception,), {}),
    )
    _module("homeassistant.helpers", __path__=[])
    _module("homeassistant.helpers.entity_registry", async_get=lambda _hass: None)
    class FakeUpdateFailed(Exception):
        def __init__(self, message, *, retry_after=None):
            super().__init__(message)
            self.retry_after = retry_after

    _module(
        "homeassistant.helpers.update_coordinator",
        DataUpdateCoordinator=type("DataUpdateCoordinator", (), {}),
        UpdateFailed=FakeUpdateFailed,
    )
    _module("homeassistant.util", __path__=[])
    _module(
        "homeassistant.util.dt",
        now=lambda: dt.datetime.now(UTC),
        utcnow=lambda: dt.datetime.now(UTC),
        as_utc=lambda value: value.astimezone(UTC),
        get_time_zone=lambda _name: UTC,
        DEFAULT_TIME_ZONE=UTC,
    )

    api_types = {
        name: type(name, (), {"from_dict": staticmethod(lambda _value: None)})
        for name in (
            "ClimateRequestOptions",
            "POIInfo",
            "ScheduleChargingClimateRequestOptions",
            "Token",
            "Vehicle",
            "VehicleManager",
            "WindowRequestOptions",
        )
    }
    _module("hyundai_kia_connect_api", **api_types)
    _module(
        "hyundai_kia_connect_api.const",
        WINDOW_STATE=SimpleNamespace(OPEN="open", CLOSED="closed", VENTILATION="ventilation"),
    )
    _module(
        "hyundai_kia_connect_api.exceptions",
        APIError=type("APIError", (Exception,), {}),
        AuthenticationError=type("AuthenticationError", (Exception,), {}),
        UnsupportedControlError=type("UnsupportedControlError", (Exception,), {}),
    )

    _module("custom_components", __path__=[])
    _module("custom_components.kia_uvo", __path__=[str(package_root)])
    for short_name in ("const", "coordinator"):
        full_name = f"custom_components.kia_uvo.{short_name}"
        spec = importlib.util.spec_from_file_location(full_name, package_root / f"{short_name}.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        spec.loader.exec_module(module)
    return sys.modules["custom_components.kia_uvo.coordinator"].HyundaiKiaConnectDataUpdateCoordinator


UTC = dt.timezone.utc
HyundaiKiaConnectDataUpdateCoordinator = _load_coordinator_without_home_assistant()


VEHICLE_ID = "vehicle-1"
FUEL_ENTITY = "sensor.vehicle_primary_fuel_level"
RANGE_ENTITY = "sensor.vehicle_primary_fuel_driving_range"


class FakeHass:
    """Minimal Home Assistant surface used by the estimator."""

    config = SimpleNamespace(time_zone="UTC")


class FakeRecorder:
    """Execute the recorder callback synchronously in the test loop."""

    keep_days = 30

    async def async_add_executor_job(self, callback):
        return callback()


class FakeRegistry:
    """Resolve the recorder entities required by the estimator."""

    @staticmethod
    def async_get_entity_id(platform, domain, unique_id):
        del platform, domain
        if unique_id.endswith("_fuel_level"):
            return FUEL_ENTITY
        if "recent-trip-info" in unique_id:
            return "sensor.vehicle_primary_recent_trip_info"
        return RANGE_ENTITY


def reading(at: str, value: float):
    """Build a recorder-like state with a UTC timestamp."""

    return SimpleNamespace(
        last_updated=dt.datetime.fromisoformat(at).replace(tzinfo=UTC),
        state=str(value),
    )


def trip_snapshot(*trips):
    """Build a recorder state containing retained recent-trip attributes."""

    return SimpleNamespace(attributes={"trips": list(trips)})


def trip(
    started_at: str = "1999-01-01T10:00:00",
    distance: float = 50,
    drive_time: float = 25,
    idle_time: float = 5,
):
    """Build the subset of a trip-info record used by the estimator."""

    return {
        "started_at": started_at,
        "drive_time_min": drive_time,
        "idle_time_min": idle_time,
        "duration_min": drive_time + idle_time,
        "distance": distance,
    }


async def estimate(trips, fuel_readings, range_readings, trip_snapshots=None):
    """Run the production estimator with deterministic recorder history."""

    coordinator = SimpleNamespace(
        hass=FakeHass(),
        vehicle_manager=SimpleNamespace(
            vehicles={VEHICLE_ID: SimpleNamespace(id="vehicle_primary")}
        ),
        recent_trip_info={
            VEHICLE_ID: {
                "period_start": "19981231",
                "period_end": "19990101",
                "trips": trips,
            }
        },
        fuel_efficiency={},
    )
    states = {
        FUEL_ENTITY: fuel_readings,
        RANGE_ENTITY: range_readings,
        "sensor.vehicle_primary_recent_trip_info": trip_snapshots or [],
    }
    with (
        patch("custom_components.kia_uvo.coordinator.er.async_get", return_value=FakeRegistry()),
        patch("custom_components.kia_uvo.coordinator.get_instance", return_value=FakeRecorder()),
        patch(
            "custom_components.kia_uvo.coordinator.history.get_significant_states",
            return_value=states,
        ),
    ):
        await HyundaiKiaConnectDataUpdateCoordinator._async_update_fuel_efficiency(
            coordinator, VEHICLE_ID
        )
    return coordinator.fuel_efficiency[VEHICLE_ID] | {
        "_recent_trips": coordinator.recent_trip_info[VEHICLE_ID]["trips"]
    }


async def main() -> None:
    """Exercise accepted, missing, stale and inconsistent recorder windows."""

    fuel_readings = [
        reading("1999-01-01T09:00:00", 80),
        reading("1999-01-01T10:00:00", 77.5),
        reading("1999-01-01T11:00:00", 75),
        reading("1999-01-01T12:00:00", 72.5),
        reading("1999-01-01T13:00:00", 70),
    ]
    range_readings = [
        reading("1999-01-01T09:00:30", 400),
        reading("1999-01-01T10:00:30", 387.5),
        reading("1999-01-01T11:00:30", 375),
        reading("1999-01-01T12:00:30", 362.5),
        reading("1999-01-01T13:00:30", 350),
    ]
    valid = await estimate([trip()], fuel_readings, range_readings)
    assert valid["km_per_l"] == 10.0
    assert valid["data_sufficient"] is True
    assert valid["period_start"] == "19981231"
    assert valid["period_end"] == "19990101"
    assert valid["samples_used"] == 5
    assert valid["fuel_span_percent"] == 10
    assert valid["search_window_days"] == 30
    assert valid["_recent_trips"][0]["estimated_km_per_l"] == 10.0
    assert valid["_recent_trips"][0]["estimated_liters"] == 5.0

    modeled = await estimate(
        [
            trip(distance=10, drive_time=20, idle_time=0)
            | {"date": "19990101", "start_time": "100000"},
            trip(
                "1999-01-01T11:00:00",
                distance=10,
                drive_time=10,
                idle_time=10,
            )
            | {"date": "19990101", "start_time": "110000"},
        ],
        fuel_readings,
        range_readings,
    )
    modeled_trips = modeled["_recent_trips"]
    assert modeled["trips_modeled"] == 2
    assert modeled_trips[0]["estimated_km_per_l"] == 15.0
    assert modeled_trips[1]["estimated_km_per_l"] == 7.5
    assert round(sum(item["estimated_liters"] for item in modeled_trips), 2) == 2.0

    missing = await estimate(
        [trip()],
        [reading("1999-01-01T09:50:00", 80)],
        [reading("1999-01-01T09:50:00", 400)],
    )
    assert missing["data_sufficient"] is False
    assert missing["km_per_l"] is None
    assert missing["samples_used"] == 1

    stale = await estimate(
        [trip()],
        fuel_readings,
        [
            reading("1999-01-01T09:06:00", 400),
            reading("1999-01-01T10:06:00", 387.5),
            reading("1999-01-01T11:06:00", 375),
            reading("1999-01-01T12:06:00", 362.5),
            reading("1999-01-01T13:06:00", 350),
        ],
    )
    assert stale["data_sufficient"] is False
    assert stale["maximum_sample_gap_minutes"] == 5

    implausible = await estimate(
        [trip(distance=50)],
        fuel_readings,
        [reading(item.last_updated.isoformat(), 2000) for item in fuel_readings],
    )
    assert implausible["data_sufficient"] is False
    assert implausible["samples_used"] == 0

    maximum_window = await estimate(
        [trip(distance=25)],
        fuel_readings,
        range_readings,
        [trip_snapshot(trip("1998-12-31T10:00:00", distance=25) | {
            "date": "19981231", "start_time": "100000"
        })],
    )
    assert maximum_window["km_per_l"] == 10.0
    assert maximum_window["trips_available"] == 2
    assert maximum_window["period_start"] == "19981231"
    assert maximum_window["period_end"] == "19990101"

    trip_refresh_calls = []

    class FakeTask:
        @staticmethod
        def done():
            return False

    class BackgroundHass:
        def async_create_background_task(self, coro, name):
            trip_refresh_calls.append((name, coro))
            return FakeTask()

    async def refresh_trip_info(vehicle_id):
        trip_refresh_calls.append(vehicle_id)

    vehicle = SimpleNamespace(_odometer=(1000, "km"))
    coordinator = SimpleNamespace(
        hass=BackgroundHass(),
        vehicle_manager=SimpleNamespace(vehicles={VEHICLE_ID: vehicle}),
        _last_trip_refresh_odometer={},
        _trip_history_initialized=set(),
        _trip_refresh_tasks={},
        _last_trip_refresh_success_at={},
        async_refresh_day_trip_info=refresh_trip_info,
    )
    coordinator._schedule_trip_info_refresh = MethodType(
        HyundaiKiaConnectDataUpdateCoordinator._schedule_trip_info_refresh,
        coordinator,
    )
    coordinator._async_refresh_trip_info_with_retry = MethodType(
        HyundaiKiaConnectDataUpdateCoordinator._async_refresh_trip_info_with_retry,
        coordinator,
    )
    await HyundaiKiaConnectDataUpdateCoordinator._async_refresh_trip_info_on_new_distance(
        coordinator
    )
    assert len(trip_refresh_calls) == 1
    assert "startup" in trip_refresh_calls[0][0]
    assert coordinator._last_trip_refresh_odometer[VEHICLE_ID] == 1000

    # The fake scheduler must close the unexecuted coroutine cleanly.
    trip_refresh_calls[0][1].close()
    coordinator._trip_refresh_tasks.clear()
    coordinator._last_trip_refresh_success_at[VEHICLE_ID] = dt.datetime.now(UTC)

    vehicle._odometer = (1001, "km")
    await HyundaiKiaConnectDataUpdateCoordinator._async_refresh_trip_info_on_new_distance(
        coordinator
    )
    assert len(trip_refresh_calls) == 2
    assert "odometer_movement" in trip_refresh_calls[1][0]
    trip_refresh_calls[1][1].close()
    coordinator._trip_refresh_tasks.clear()

    # No movement and a recent successful load must not hit /tripinfo again.
    await HyundaiKiaConnectDataUpdateCoordinator._async_refresh_trip_info_on_new_distance(
        coordinator
    )
    assert len(trip_refresh_calls) == 2

    # The six-hour fallback repairs missed movement or delayed backend data.
    coordinator._last_trip_refresh_success_at[VEHICLE_ID] -= dt.timedelta(hours=7)
    await HyundaiKiaConnectDataUpdateCoordinator._async_refresh_trip_info_on_new_distance(
        coordinator
    )
    assert len(trip_refresh_calls) == 3
    assert "periodic_fallback" in trip_refresh_calls[2][0]
    trip_refresh_calls[2][1].close()

    print("vehicle_primary consumption estimate: 9 cenários aprovados.")


class VehiclePrimaryConsumptionTest(unittest.IsolatedAsyncioTestCase):
    async def test_recorder_estimate_and_refresh_scenarios(self):
        await main()


class FakeResponse:
    """Small requests-like response for BR device recovery tests."""

    def __init__(self, status_code, payload):
        self.status_code = status_code
        self.payload = payload

    def json(self):
        return self.payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSession:
    """Return deterministic API responses and retain request metadata."""

    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def request(self, method, url, **kwargs):
        self.requests.append((method, url, kwargs))
        return next(self.responses)

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)


class HyundaiBlueLinkApiBR:
    """Minimum BR API surface used by the compatibility installer."""

    ccsp_application_id = "legacy-application"
    ccsp_service_id = "service-id"

    def __init__(self, responses):
        self.api_headers = {"User-Agent": "legacy-agent"}
        self.session = FakeSession(responses)

    @staticmethod
    def _build_api_url(path):
        return f"https://example.invalid/api/v1/{path.lstrip('/')}"


class VehiclePrimaryBrazilDeviceRecoveryTest(unittest.TestCase):
    def test_invalid_device_is_registered_persisted_and_retried_once(self):
        api = HyundaiBlueLinkApiBR(
            [
                FakeResponse(400, {"retCode": "F", "resCode": "4002"}),
                FakeResponse(
                    200,
                    {
                        "retCode": "S",
                        "resCode": "0000",
                        "resMsg": {"deviceId": "registered-device"},
                    },
                ),
                FakeResponse(200, {"retCode": "S", "resCode": "0000"}),
            ]
        )
        token = SimpleNamespace(device_id="legacy-device")
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(api=api, token=token)
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )
        response = api.session.get(
            "https://example.invalid/api/v1/spa/vehicles",
            headers={"ccsp-device-id": "legacy-device"},
            json={"deviceId": "legacy-device"},
        )

        assert response.status_code == 200
        assert token.device_id == "registered-device"
        assert len(api.session.requests) == 3
        registration = api.session.requests[1]
        assert registration[0] == "POST"
        assert registration[1].endswith("/spa/notifications/register")
        assert registration[2]["json"]["pushType"] == "GCM"
        retry = api.session.requests[2]
        assert retry[2]["headers"]["ccsp-device-id"] == "registered-device"
        assert retry[2]["json"]["deviceId"] == "registered-device"
        assert api.ccsp_application_id.endswith("a2df127d73b0")
        assert api.api_headers["User-Agent"].endswith("_CCS_APP_AOS")

    def test_other_bad_request_is_not_registered_or_retried(self):
        api = HyundaiBlueLinkApiBR(
            [FakeResponse(400, {"retCode": "F", "resCode": "4003"})]
        )
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(
                api=api, token=SimpleNamespace(device_id="still-valid")
            )
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )
        response = api.session.get(
            "https://example.invalid/api/v1/spa/vehicles",
            headers={"ccsp-device-id": "still-valid"},
        )

        assert response.status_code == 400
        assert len(api.session.requests) == 1


class VehiclePrimaryRefreshOwnershipTest(unittest.IsolatedAsyncioTestCase):
    """Keep cache polling in HA while Node-RED owns real-wake scheduling."""

    async def test_periodic_coordinator_reads_cache_without_native_wake(self):
        calls = []

        class Manager:
            api = HyundaiBlueLinkApiBR([])

            @staticmethod
            def update_all_vehicles_with_cached_state():
                calls.append("cache")

            @staticmethod
            def check_and_force_update_vehicles(*_args):
                raise AssertionError("Home Assistant must not schedule a real wake")

        class Hass:
            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

        async def no_op():
            return None

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            scan_interval=15 * 60,
            force_refresh_interval=24 * 60 * 60,
            data={},
            async_check_and_refresh_token=no_op,
            _install_br_parser_compatibility=lambda: None,
            _async_refresh_trip_info_on_new_distance=no_op,
            _async_save_token=no_op,
        )
        result = await HyundaiKiaConnectDataUpdateCoordinator._async_update_data(
            coordinator
        )
        assert result == {}
        assert calls == ["cache"]

    async def test_force_refresh_rejects_a_concurrent_request(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = []

        class Manager:
            api = HyundaiBlueLinkApiBR([])
            vehicles = {VEHICLE_ID: SimpleNamespace(last_updated_at=None)}

            @staticmethod
            def force_refresh_vehicle_state(vehicle_id):
                calls.append(vehicle_id)

        class Hass:
            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

        async def wait_for_release():
            started.set()
            await release.wait()

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            _br_last_button_wake_at=None,
            async_check_and_refresh_token=wait_for_release,
            data={},
            async_set_updated_data=lambda _data: None,
        )
        first = asyncio.create_task(
            HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
                coordinator, VEHICLE_ID
            )
        )
        await started.wait()
        with self.assertRaisesRegex(Exception, "already in progress"):
            await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
                coordinator, VEHICLE_ID
            )
        release.set()
        await first
        assert calls == [VEHICLE_ID]

    async def test_force_refresh_without_fresh_br_data_preserves_cache(self):
        calls = []
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]

        class Manager:
            api = HyundaiBlueLinkApiBR([])
            vehicles = {VEHICLE_ID: SimpleNamespace(last_updated_at=None)}

            @staticmethod
            def force_refresh_vehicle_state(_vehicle_id):
                calls.append("wake")
                raise coordinator_module.APIError(
                    "Brazilian Hyundai force refresh did not return fresh data in time; "
                    "vehicle may be unreachable."
                )

            @staticmethod
            def update_vehicle_with_cached_state(_vehicle_id):
                calls.append("cache")

        class Hass:
            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

        async def no_op():
            return None

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            _br_last_button_wake_at=None,
            async_check_and_refresh_token=no_op,
            data={},
            async_set_updated_data=lambda _data: None,
        )
        await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
            coordinator, VEHICLE_ID
        )
        assert calls == ["wake", "cache"]

    async def test_force_refresh_allows_sequential_manual_wakes(self):
        calls = []

        class Manager:
            api = HyundaiBlueLinkApiBR([])
            vehicles = {VEHICLE_ID: SimpleNamespace(last_updated_at=None)}

            @staticmethod
            def force_refresh_vehicle_state(vehicle_id):
                calls.append(vehicle_id)

        class Hass:
            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

        async def no_op():
            return None

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            async_check_and_refresh_token=no_op,
            data={},
            async_set_updated_data=lambda _data: None,
        )
        await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
            coordinator, VEHICLE_ID
        )
        await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
            coordinator, VEHICLE_ID
        )
        assert calls == [VEHICLE_ID, VEHICLE_ID]

    async def test_force_refresh_unexpected_failure_is_surfaced(self):
        class Manager:
            api = HyundaiBlueLinkApiBR([])
            vehicles = {VEHICLE_ID: SimpleNamespace(last_updated_at=None)}

            @staticmethod
            def force_refresh_vehicle_state(_vehicle_id):
                raise RuntimeError("synthetic programming failure")

            @staticmethod
            def update_vehicle_with_cached_state(_vehicle_id):
                return None

        class Hass:
            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

        async def no_op():
            return None

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            _br_last_button_wake_at=None,
            async_check_and_refresh_token=no_op,
            data={},
            async_set_updated_data=lambda _data: None,
        )
        with self.assertRaisesRegex(Exception, "Vehicle refresh failed"):
            await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
                coordinator, VEHICLE_ID
            )

    async def test_force_refresh_br_auth_failure_uses_evidence_backoff(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]

        class Manager:
            api = HyundaiBlueLinkApiBR([])

        async def fail_auth():
            raise coordinator_module.AuthenticationError("temporary sign-in failure")

        published = []
        coordinator = SimpleNamespace(
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            async_check_and_refresh_token=fail_auth,
            data={"cached": True},
            async_set_updated_data=published.append,
        )
        await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
            coordinator, VEHICLE_ID
        )
        assert published == [{"cached": True}]

    async def test_br_authentication_failure_retries_without_unloading_entry(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]

        class Manager:
            api = HyundaiBlueLinkApiBR([])

        async def fail_auth():
            raise coordinator_module.AuthenticationError("401 Unauthorized")

        coordinator = SimpleNamespace(
            vehicle_manager=Manager(),
            scan_interval=15 * 60,
            force_refresh_interval=24 * 60 * 60,
            async_check_and_refresh_token=fail_auth,
        )
        with self.assertRaises(coordinator_module.UpdateFailed) as raised:
            await HyundaiKiaConnectDataUpdateCoordinator._async_update_data(coordinator)
        assert raised.exception.retry_after == 15 * 60


if __name__ == "__main__":
    unittest.main()
