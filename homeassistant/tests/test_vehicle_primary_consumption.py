"""Regression tests for the vehicle_primary range-based consumption estimate."""

from __future__ import annotations

import asyncio
import datetime as dt
import importlib.util
import sys
import unittest
from enum import Enum
from pathlib import Path
from types import MethodType, ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, patch


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

    class FakeStore:
        def __init__(self, _hass, _version, key, **_kwargs):
            self.key = key
            self.data = None

        async def async_load(self):
            return self.data

        def async_delay_save(self, data_func, _delay=0):
            self.data = data_func()

    _module("homeassistant.helpers.storage", Store=FakeStore)

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
        ORDER_STATUS=Enum(
            "ORDER_STATUS",
            {
                "PENDING": "PENDING",
                "SUCCESS": "SUCCESS",
                "FAILED": "FAILED",
                "TIMEOUT": "TIMEOUT",
                "UNKNOWN": "UNKNOWN",
            },
        ),
        WINDOW_STATE=SimpleNamespace(OPEN="open", CLOSED="closed", VENTILATION="ventilation"),
    )
    _module(
        "hyundai_kia_connect_api.exceptions",
        APIError=type("APIError", (Exception,), {}),
        AuthenticationError=type("AuthenticationError", (Exception,), {}),
        RateLimitingError=type("RateLimitingError", (Exception,), {}),
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
ORDER_STATUS = sys.modules[
    "custom_components.kia_uvo.coordinator"
].ORDER_STATUS


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


class FakeActionHass:
    """Execute a remote command request without a Home Assistant runtime."""

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


class RemoteCommandLifecycleTests(unittest.IsolatedAsyncioTestCase):
    """A final provider result must be observable outside the service call."""

    @staticmethod
    def coordinator(*, confirmation_error=None, confirmation_result=None):
        statuses = []
        coordinator = SimpleNamespace(
            _action_lock=asyncio.Lock(),
            hass=FakeActionHass(),
            async_check_and_refresh_token=AsyncMock(),
            async_await_action_and_refresh=AsyncMock(
                side_effect=confirmation_error,
                return_value=(
                    ORDER_STATUS.SUCCESS
                    if confirmation_result is None
                    else confirmation_result
                ),
            ),
            async_await_action_and_force_refresh=AsyncMock(),
            _set_remote_command_status=lambda _vehicle_id, state, **attributes: (
                statuses.append({"state": state, **attributes})
            ),
        )
        coordinator._set_remote_command_failure = MethodType(
            HyundaiKiaConnectDataUpdateCoordinator._set_remote_command_failure,
            coordinator,
        )
        coordinator._remote_command_error_summary = (
            HyundaiKiaConnectDataUpdateCoordinator._remote_command_error_summary
        )
        return coordinator, statuses

    async def test_confirmation_failure_is_published_and_raised(self):
        coordinator, statuses = self.coordinator(
            confirmation_result=ORDER_STATUS.FAILED
        )
        with (
            patch.object(
                HyundaiKiaConnectDataUpdateCoordinator,
                "_raise_if_br_rate_limited",
            ),
            self.assertRaises(Exception),
        ):
            await HyundaiKiaConnectDataUpdateCoordinator._async_send_action(
                coordinator,
                VEHICLE_ID,
                lambda: "provider-action-id",
                "unlock vehicle",
                status_command="unlock",
            )

        self.assertEqual(statuses[0]["state"], "requesting")
        self.assertEqual(statuses[1]["result_stage"], "awaiting_confirmation")
        self.assertEqual(statuses[-1]["state"], "failed")
        self.assertEqual(statuses[-1]["failure_stage"], "confirmation_result")
        self.assertEqual(statuses[-1]["command"], "unlock")
        self.assertIn("FAILED", statuses[-1]["reason"])

    async def test_confirmation_success_is_published(self):
        coordinator, statuses = self.coordinator()
        with patch.object(
            HyundaiKiaConnectDataUpdateCoordinator,
            "_raise_if_br_rate_limited",
        ):
            await HyundaiKiaConnectDataUpdateCoordinator._async_send_action(
                coordinator,
                VEHICLE_ID,
                lambda: "provider-action-id",
                "unlock vehicle",
                status_command="unlock",
            )

        self.assertEqual(statuses[-1]["state"], "accepted")
        self.assertEqual(statuses[-1]["result_stage"], "confirmed")
        self.assertEqual(statuses[-1]["command"], "unlock")


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

    async def test_unload_cancels_coordinator_background_tasks(self):
        cancelled = []

        async def pending_task(name):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(name)

        shared = asyncio.create_task(pending_task("shared"))
        trip = asyncio.create_task(pending_task("trip"))
        await asyncio.sleep(0)
        coordinator = SimpleNamespace(
            _trip_refresh_tasks={"vehicle-1": trip},
            _br_fresh_data_recheck_tasks={"vehicle-1": shared, "duplicate": shared},
        )

        await HyundaiKiaConnectDataUpdateCoordinator.async_cancel_background_tasks(
            coordinator
        )

        assert set(cancelled) == {"shared", "trip"}
        assert coordinator._trip_refresh_tasks == {}
        assert coordinator._br_fresh_data_recheck_tasks == {}
        assert shared.cancelled()
        assert trip.cancelled()


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

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)


class HyundaiBlueLinkApiBR:
    """Minimum BR API surface used by the compatibility installer."""

    ccsp_application_id = "legacy-application"
    ccsp_service_id = "service-id"

    def __init__(self, responses):
        self.api_url = "https://example.invalid/api/v1/"
        self.basic_authorization_header = "synthetic-basic"
        self.base_url = "example.invalid"
        self.api_headers = {"User-Agent": "legacy-agent"}
        self.session = FakeSession(responses)
        self.login_calls = 0
        self.login_arguments = []

    @staticmethod
    def _build_api_url(path):
        return f"https://example.invalid/api/v1/{path.lstrip('/')}"

    def login(self, username, password, otp_handler=None, pin=None):
        self.login_calls += 1
        self.login_arguments.append(
            {
                "username": username,
                "password": password,
                "otp_handler": otp_handler,
                "pin": pin,
            }
        )
        return "full-login"

    def refresh_access_token(self, token):
        response = self.session.post(
            self.USER_API_URL + "oauth2/token",
            data="grant_type=refresh_token&refresh_token=synthetic",
        )
        payload = response.json()
        if payload.get("retCode") == "F":
            try:
                coordinator_module = sys.modules[
                    "custom_components.kia_uvo.coordinator"
                ]
                if payload.get("resCode") == "5091":
                    raise coordinator_module.RateLimitingError(payload["resMsg"])
                raise coordinator_module.APIError(payload.get("resMsg", "failed"))
            except Exception:
                return self.login(token.username, token.password, token.pin)
        return SimpleNamespace(access_token="Bearer refreshed-token")

    def update_day_trip_info(self, token, vehicle, yyyymmdd_string):
        del token, vehicle, yyyymmdd_string
        response = self.session.post(
            self._build_api_url("/spa/vehicles/vehicle-1/tripinfo")
        )
        try:
            response.raise_for_status()
        except Exception:
            # Mirrors the upstream BR client, which logs and swallows errors.
            return None
        return response.json()


class VehiclePrimaryBrazilDeviceRecoveryTest(unittest.TestCase):
    def test_refresh_rate_limit_does_not_fall_back_to_full_login(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        api = HyundaiBlueLinkApiBR(
            [
                FakeResponse(
                    200,
                    {
                        "retCode": "F",
                        "resCode": "5091",
                        "resMsg": "Exceeds number of requests",
                    },
                )
            ]
        )
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(api=api, token=None)
        )
        token = SimpleNamespace(
            username="synthetic-user",
            password="placeholder",
            pin="synthetic-pin",
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )

        with self.assertRaises(coordinator_module.RateLimitingError):
            api.refresh_access_token(token)
        assert api.login_calls == 0
        assert len(api.session.requests) == 1
        assert api.USER_API_URL.endswith("/user/")
        assert api.BASIC_AUTHORIZATION == "synthetic-basic"
        assert api.BASE_URL == "example.invalid"

    def test_refresh_fallback_passes_pin_by_keyword_for_br_login(self):
        api = HyundaiBlueLinkApiBR(
            [
                FakeResponse(
                    200,
                    {
                        "retCode": "F",
                        "resCode": "5000",
                        "resMsg": "Synthetic refresh failure",
                    },
                )
            ]
        )
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(api=api, token=None)
        )
        token = SimpleNamespace(
            username="synthetic-user",
            password="placeholder",
            pin="synthetic-pin",
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )

        assert api.refresh_access_token(token) == "full-login"
        assert api.login_calls == 1
        assert api.login_arguments == [
            {
                "username": "synthetic-user",
                "password": "placeholder",
                "otp_handler": None,
                "pin": "synthetic-pin",
            }
        ]

    def test_successful_refresh_keeps_raw_br_access_token(self):
        api = HyundaiBlueLinkApiBR(
            [FakeResponse(200, {"access_token": "synthetic"})]
        )
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(api=api, token=None)
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )
        result = api.refresh_access_token(SimpleNamespace())

        assert result.access_token == "refreshed-token"
        assert api.login_calls == 0

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

    def test_invalid_device_in_http_403_is_registered_and_retried_once(self):
        api = HyundaiBlueLinkApiBR(
            [
                FakeResponse(403, {"retCode": "F", "resCode": "4002"}),
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
        )

        assert response.status_code == 200
        assert token.device_id == "registered-device"
        assert len(api.session.requests) == 3

    def test_trip_info_http_403_is_not_swallowed_by_upstream_client(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        api = HyundaiBlueLinkApiBR(
            [FakeResponse(403, {"retCode": "F", "resCode": "5000"})]
        )
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(
                api=api,
                token=SimpleNamespace(device_id="registered-device"),
            )
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )

        with self.assertRaisesRegex(
            coordinator_module.RateLimitingError,
            "HTTP 403",
        ):
            api.update_day_trip_info(
                coordinator.vehicle_manager.token,
                SimpleNamespace(),
                "20260903",
            )

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

    def test_wake_http_200_failure_envelope_is_rejected(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        api = HyundaiBlueLinkApiBR(
            [
                FakeResponse(
                    200,
                    {
                        "retCode": "F",
                        "resCode": "5031",
                        "resMsg": "synthetic provider failure",
                    },
                )
            ]
        )
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(
                api=api, token=SimpleNamespace(device_id="registered-device")
            )
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )

        with self.assertRaisesRegex(
            coordinator_module.APIError,
            r"/ccs2/carstatus.*resCode=5031",
        ):
            api.session.get(
                "https://example.invalid/api/v1/spa/vehicles/vehicle/ccs2/carstatus",
                headers={"ccsp-device-id": "registered-device"},
            )

    def test_wake_success_envelope_remains_accepted(self):
        api = HyundaiBlueLinkApiBR(
            [FakeResponse(200, {"retCode": "S", "resCode": "0000"})]
        )
        coordinator = SimpleNamespace(
            vehicle_manager=SimpleNamespace(
                api=api, token=SimpleNamespace(device_id="registered-device")
            )
        )

        HyundaiKiaConnectDataUpdateCoordinator._install_br_client_compatibility(
            coordinator
        )
        response = api.session.get(
            "https://example.invalid/api/v1/spa/vehicles/vehicle/ccs2/carstatus",
            headers={"ccsp-device-id": "registered-device"},
        )

        assert response.status_code == 200
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
            _force_refresh_lock=asyncio.Lock(),
            _cache_refresh_lock=asyncio.Lock(),
            scan_interval=15 * 60,
            force_refresh_interval=24 * 60 * 60,
            data={},
            async_check_and_refresh_token=no_op,
            _install_br_parser_compatibility=lambda: None,
            _async_refresh_trip_info_on_new_distance=no_op,
            _async_save_token=no_op,
        )
        coordinator._async_update_data_from_cache = MethodType(
            HyundaiKiaConnectDataUpdateCoordinator._async_update_data_from_cache,
            coordinator,
        )
        for _ in range(3):
            result = await HyundaiKiaConnectDataUpdateCoordinator._async_update_data(
                coordinator
            )
            assert result == {}
        assert calls == ["cache", "cache", "cache"]

    def test_br_cache_poll_uses_bounded_15_minute_cadence(self):
        assert (
            HyundaiKiaConnectDataUpdateCoordinator._cache_poll_interval_seconds(
                HyundaiBlueLinkApiBR([]),
                15 * 60,
            )
            == 15 * 60
        )

        class OtherRegionApi:
            pass

        assert (
            HyundaiKiaConnectDataUpdateCoordinator._cache_poll_interval_seconds(
                OtherRegionApi(),
                15 * 60,
            )
            == 15 * 60
        )

    async def test_br_rate_limit_backs_off_without_repolling(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        calls = []
        events = []

        class Manager:
            api = HyundaiBlueLinkApiBR([])

            @staticmethod
            def update_all_vehicles_with_cached_state():
                calls.append("cache")
                raise coordinator_module.RateLimitingError("synthetic limit")

        class Bus:
            @staticmethod
            def async_fire(event_type, event_data):
                events.append((event_type, event_data))

        class Hass:
            bus = Bus()

            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

        async def no_op():
            return None

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _br_rate_limit_key="shared-retry-test",
            scan_interval=15 * 60,
            force_refresh_interval=24 * 60 * 60,
            async_check_and_refresh_token=no_op,
            _install_br_parser_compatibility=lambda: None,
            _async_refresh_trip_info_on_new_distance=no_op,
            _async_save_token=no_op,
        )
        for method in (
            "_br_rate_limit_remaining_seconds",
            "_record_br_rate_limit",
            "_clear_br_rate_limit",
        ):
            setattr(
                coordinator,
                method,
                MethodType(
                    getattr(HyundaiKiaConnectDataUpdateCoordinator, method),
                    coordinator,
                ),
            )

        with (
            patch.object(coordinator_module.time, "monotonic", return_value=1_000),
            patch.object(coordinator_module.time, "time", return_value=10_000),
        ):
            with self.assertRaises(coordinator_module.UpdateFailed) as first:
                await HyundaiKiaConnectDataUpdateCoordinator._async_update_data_from_cache(
                    coordinator
                )
        assert first.exception.retry_after == 15 * 60
        assert calls == ["cache"]
        assert events[-1][0] == "kia_uvo_api_retry"
        assert events[-1][1]["status"] == "rate_limited"
        assert events[-1][1]["retry_after_seconds"] == 15 * 60
        assert dt.datetime.fromisoformat(events[-1][1]["retry_at"]).tzinfo is not None

        retrying_coordinator = SimpleNamespace(
            vehicle_manager=Manager(),
            _br_rate_limit_key="shared-retry-test",
            scan_interval=15 * 60,
            force_refresh_interval=24 * 60 * 60,
        )
        with (
            patch.object(coordinator_module.time, "monotonic", return_value=1_001),
            patch.object(coordinator_module.time, "time", return_value=10_001),
        ):
            with self.assertRaises(coordinator_module.UpdateFailed) as second:
                await HyundaiKiaConnectDataUpdateCoordinator._async_update_data_from_cache(
                    retrying_coordinator
                )
        assert second.exception.retry_after == 15 * 60 - 1
        assert calls == ["cache"]
        HyundaiKiaConnectDataUpdateCoordinator._clear_br_rate_limit(coordinator)
        assert events[-1] == (
            "kia_uvo_api_retry",
            {
                "status": "available",
                "retry_at": None,
                "retry_after_seconds": 0,
            },
        )

    async def test_force_refresh_rate_limit_skips_cached_fallback(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        calls = []

        class Manager:
            api = HyundaiBlueLinkApiBR([])
            vehicles = {VEHICLE_ID: SimpleNamespace(last_updated_at=None)}

            @staticmethod
            def force_refresh_vehicle_state(_vehicle_id):
                calls.append("wake")
                raise coordinator_module.RateLimitingError("synthetic limit")

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
            _cache_refresh_lock=asyncio.Lock(),
            _br_rate_limit_key="force-refresh-test",
            async_check_and_refresh_token=no_op,
            data={"cached": True},
            async_set_updated_data=lambda _data: None,
        )
        for method in (
            "_br_rate_limit_remaining_seconds",
            "_record_br_rate_limit",
            "_raise_if_br_rate_limited",
        ):
            setattr(
                coordinator,
                method,
                MethodType(
                    getattr(HyundaiKiaConnectDataUpdateCoordinator, method),
                    coordinator,
                ),
            )

        with self.assertRaisesRegex(Exception, "rate limit"):
            await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
                coordinator, VEHICLE_ID
            )
        assert calls == ["wake"]

    async def test_force_refresh_http_403_enters_backoff_without_cached_fallback(self):
        calls = []

        class Manager:
            api = HyundaiBlueLinkApiBR([])
            vehicles = {VEHICLE_ID: SimpleNamespace(last_updated_at=None)}

            @staticmethod
            def force_refresh_vehicle_state(_vehicle_id):
                calls.append("wake")
                raise RuntimeError("403 Client Error: Forbidden")

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
            _cache_refresh_lock=asyncio.Lock(),
            _br_rate_limit_key="force-refresh-forbidden-test",
            async_check_and_refresh_token=no_op,
            data={"cached": True},
            async_set_updated_data=lambda _data: None,
        )
        for method in (
            "_br_rate_limit_remaining_seconds",
            "_record_br_rate_limit",
            "_raise_if_br_rate_limited",
        ):
            setattr(
                coordinator,
                method,
                MethodType(
                    getattr(HyundaiKiaConnectDataUpdateCoordinator, method),
                    coordinator,
                ),
            )

        with self.assertRaisesRegex(Exception, "provider denied"):
            await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
                coordinator, VEHICLE_ID
            )
        assert calls == ["wake"]
        assert (
            HyundaiKiaConnectDataUpdateCoordinator._br_rate_limit_remaining_seconds(
                coordinator
            )
            > 0
        )

    async def test_br_rate_limit_backoff_survives_coordinator_restart(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        store_type = sys.modules["homeassistant.helpers.storage"].Store
        events = []

        class Bus:
            @staticmethod
            def async_fire(event_type, event_data):
                events.append((event_type, event_data))

        store = store_type(None, 1, "synthetic-rate-limit", private=True)
        store.data = {"failures": 4, "until_epoch": 8_200.0}
        coordinator = SimpleNamespace(
            hass=SimpleNamespace(bus=Bus()),
            vehicle_manager=SimpleNamespace(api=HyundaiBlueLinkApiBR([])),
            _br_rate_limit_key="persistent-retry-test",
            _br_rate_limit_store=store,
        )

        with (
            patch.object(coordinator_module.time, "time", return_value=1_000),
            patch.object(coordinator_module.time, "monotonic", return_value=500),
        ):
            await HyundaiKiaConnectDataUpdateCoordinator._async_setup(coordinator)
            remaining = HyundaiKiaConnectDataUpdateCoordinator._br_rate_limit_remaining_seconds(
                coordinator
            )

        assert remaining == 7_200
        assert coordinator_module._BR_RATE_LIMIT_STATE["persistent-retry-test"] == {
            "failures": 4,
            "until_epoch": 8_200.0,
            "until_monotonic": 7_700,
        }
        assert events[-1][0] == "kia_uvo_api_retry"
        assert events[-1][1]["retry_after_seconds"] == 7_200

        with (
            patch.object(coordinator_module.time, "time", return_value=8_201),
            patch.object(coordinator_module.time, "monotonic", return_value=7_701),
        ):
            next_delay = HyundaiKiaConnectDataUpdateCoordinator._record_br_rate_limit(
                coordinator
            )
        assert next_delay == 4 * 60 * 60
        assert store.data == {"failures": 5, "until_epoch": 22_601.0}

        HyundaiKiaConnectDataUpdateCoordinator._clear_br_rate_limit(coordinator)
        assert store.data == {"failures": 0, "until_epoch": 0.0}

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
            _cache_refresh_lock=asyncio.Lock(),
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
        tasks = []
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

            @staticmethod
            def async_create_background_task(coro, _name):
                task = asyncio.create_task(coro)
                tasks.append(task)
                return task

        async def no_op():
            return None

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            _cache_refresh_lock=asyncio.Lock(),
            _br_fresh_data_recheck_tasks={},
            _br_last_button_wake_at=None,
            async_check_and_refresh_token=no_op,
            data={},
            async_set_updated_data=lambda _data: None,
        )
        coordinator._br_timestamp_is_fresh = (
            HyundaiKiaConnectDataUpdateCoordinator._br_timestamp_is_fresh
        )
        coordinator._async_recheck_br_fresh_data = MethodType(
            HyundaiKiaConnectDataUpdateCoordinator._async_recheck_br_fresh_data,
            coordinator,
        )
        coordinator._schedule_br_fresh_data_recheck = MethodType(
            HyundaiKiaConnectDataUpdateCoordinator._schedule_br_fresh_data_recheck,
            coordinator,
        )
        await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
            coordinator, VEHICLE_ID
        )
        assert calls == ["wake", "cache"]
        tasks[0].cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def test_force_refresh_collects_delayed_br_snapshot_without_new_wake(self):
        calls = []
        tasks = []
        published = []
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        baseline = dt.datetime.now(UTC) - dt.timedelta(minutes=10)
        vehicle = SimpleNamespace(last_updated_at=baseline)

        class Manager:
            api = HyundaiBlueLinkApiBR([])
            vehicles = {VEHICLE_ID: vehicle}

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
                cache_reads = calls.count("cache")
                if cache_reads == 2:
                    vehicle.last_updated_at = baseline + dt.timedelta(seconds=30)
                elif cache_reads == 3:
                    vehicle.last_updated_at = dt.datetime.now(UTC)

        class Hass:
            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

            @staticmethod
            def async_create_background_task(coro, _name):
                task = asyncio.create_task(coro)
                tasks.append(task)
                return task

        async def no_op():
            return None

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            _cache_refresh_lock=asyncio.Lock(),
            _br_fresh_data_recheck_tasks={},
            async_check_and_refresh_token=no_op,
            data={"cached": True},
            async_set_updated_data=published.append,
        )
        coordinator._br_timestamp_is_fresh = (
            HyundaiKiaConnectDataUpdateCoordinator._br_timestamp_is_fresh
        )
        coordinator._async_recheck_br_fresh_data = MethodType(
            HyundaiKiaConnectDataUpdateCoordinator._async_recheck_br_fresh_data,
            coordinator,
        )
        coordinator._schedule_br_fresh_data_recheck = MethodType(
            HyundaiKiaConnectDataUpdateCoordinator._schedule_br_fresh_data_recheck,
            coordinator,
        )

        with patch.object(
            coordinator_module,
            "BR_FRESH_DATA_RECHECK_DELAYS_S",
            (0, 0),
        ):
            await HyundaiKiaConnectDataUpdateCoordinator.async_force_refresh_vehicle(
                coordinator,
                VEHICLE_ID,
            )
            await tasks[0]

        assert calls == ["wake", "cache", "cache", "cache"]
        assert published == [
            {"cached": True},
            {"cached": True},
            {"cached": True},
        ]
        assert coordinator._br_fresh_data_recheck_tasks == {}

    async def test_delayed_br_rechecks_publish_stale_cache_scans(self):
        published = []
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        baseline = dt.datetime.now(UTC) - dt.timedelta(minutes=10)
        vehicle = SimpleNamespace(last_updated_at=baseline)

        class Manager:
            vehicles = {VEHICLE_ID: vehicle}

            @staticmethod
            def update_vehicle_with_cached_state(_vehicle_id):
                return None

        class Hass:
            @staticmethod
            async def async_add_executor_job(callback, *args):
                return callback(*args)

        coordinator = SimpleNamespace(
            hass=Hass(),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            _cache_refresh_lock=asyncio.Lock(),
            _br_fresh_data_recheck_tasks={},
            async_check_and_refresh_token=AsyncMock(),
            data={"cached": True},
            async_set_updated_data=published.append,
        )
        coordinator._br_timestamp_is_fresh = (
            HyundaiKiaConnectDataUpdateCoordinator._br_timestamp_is_fresh
        )

        with patch.object(
            coordinator_module,
            "BR_FRESH_DATA_RECHECK_DELAYS_S",
            (0, 0),
        ):
            await HyundaiKiaConnectDataUpdateCoordinator._async_recheck_br_fresh_data(
                coordinator,
                VEHICLE_ID,
                baseline,
                dt.datetime.now(UTC),
            )

        assert published == [{"cached": True}, {"cached": True}]

    async def test_delayed_br_recheck_stops_after_authentication_failure(self):
        coordinator_module = sys.modules["custom_components.kia_uvo.coordinator"]
        vehicle = SimpleNamespace(last_updated_at=dt.datetime.now(UTC))

        class Manager:
            vehicles = {VEHICLE_ID: vehicle}

            @staticmethod
            def update_vehicle_with_cached_state(_vehicle_id):
                raise AssertionError("cache must not run without authentication")

        async def fail_authentication():
            raise coordinator_module.AuthenticationError("synthetic auth failure")

        coordinator = SimpleNamespace(
            hass=SimpleNamespace(async_add_executor_job=AsyncMock()),
            vehicle_manager=Manager(),
            _force_refresh_lock=asyncio.Lock(),
            _cache_refresh_lock=asyncio.Lock(),
            _br_fresh_data_recheck_tasks={},
            async_check_and_refresh_token=AsyncMock(side_effect=fail_authentication),
            data={"cached": True},
            async_set_updated_data=AsyncMock(),
        )
        coordinator._br_timestamp_is_fresh = (
            HyundaiKiaConnectDataUpdateCoordinator._br_timestamp_is_fresh
        )

        with patch.object(
            coordinator_module,
            "BR_FRESH_DATA_RECHECK_DELAYS_S",
            (0, 0),
        ):
            await HyundaiKiaConnectDataUpdateCoordinator._async_recheck_br_fresh_data(
                coordinator,
                VEHICLE_ID,
                vehicle.last_updated_at,
                dt.datetime.now(UTC),
            )

        coordinator.async_check_and_refresh_token.assert_awaited_once()
        coordinator.hass.async_add_executor_job.assert_not_awaited()
        coordinator.async_set_updated_data.assert_not_awaited()

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
            _cache_refresh_lock=asyncio.Lock(),
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
            _cache_refresh_lock=asyncio.Lock(),
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
            _cache_refresh_lock=asyncio.Lock(),
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
            _force_refresh_lock=asyncio.Lock(),
            _cache_refresh_lock=asyncio.Lock(),
            scan_interval=15 * 60,
            force_refresh_interval=24 * 60 * 60,
            async_check_and_refresh_token=fail_auth,
        )
        coordinator._async_update_data_from_cache = MethodType(
            HyundaiKiaConnectDataUpdateCoordinator._async_update_data_from_cache,
            coordinator,
        )
        with self.assertRaises(coordinator_module.UpdateFailed) as raised:
            await HyundaiKiaConnectDataUpdateCoordinator._async_update_data(coordinator)
        assert raised.exception.retry_after == 60


if __name__ == "__main__":
    unittest.main()
