"""Regression tests for the vehicle_primary range-based consumption estimate."""

from __future__ import annotations

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
    _module(
        "homeassistant.helpers.update_coordinator",
        DataUpdateCoordinator=type("DataUpdateCoordinator", (), {}),
        UpdateFailed=type("UpdateFailed", (Exception,), {}),
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


if __name__ == "__main__":
    unittest.main()
