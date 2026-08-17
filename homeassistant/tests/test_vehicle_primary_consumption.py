"""Regression tests for the vehicle_primary recorder-based consumption estimate."""

from __future__ import annotations

import asyncio
import datetime as dt
from types import SimpleNamespace
from unittest.mock import patch

from custom_components.kia_uvo.coordinator import HyundaiKiaConnectDataUpdateCoordinator


UTC = dt.timezone.utc
VEHICLE_ID = "vehicle-1"
FUEL_ENTITY = "sensor.vehicle_primary_fuel_level"
ODOMETER_ENTITY = "sensor.vehicle_primary_odometer"


class FakeHass:
    """Minimal Home Assistant surface used by the estimator."""

    config = SimpleNamespace(time_zone="UTC")


class FakeRecorder:
    """Execute the recorder callback synchronously in the test loop."""

    keep_days = 30

    async def async_add_executor_job(self, callback):
        return callback()


class FakeRegistry:
    """Resolve the two recorder entities required by the estimator."""

    @staticmethod
    def async_get_entity_id(platform, domain, unique_id):
        del platform, domain
        if unique_id.endswith("_fuel_level"):
            return FUEL_ENTITY
        if "recent-trip-info" in unique_id:
            return "sensor.vehicle_primary_recent_trip_info"
        return ODOMETER_ENTITY


def reading(at: str, value: float):
    """Build a recorder-like state with a UTC timestamp."""

    return SimpleNamespace(
        last_updated=dt.datetime.fromisoformat(at).replace(tzinfo=UTC),
        state=str(value),
    )


def trip_snapshot(*trips):
    """Build a recorder state containing retained recent-trip attributes."""

    return SimpleNamespace(attributes={"trips": list(trips)})


def trip(started_at: str = "1999-01-01T10:00:00", distance: float = 50):
    """Build the subset of a trip-info record used by the estimator."""

    return {
        "started_at": started_at,
        "duration_min": 30,
        "distance": distance,
    }


async def estimate(trips, fuel_readings, odometer_readings, trip_snapshots=None):
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
        ODOMETER_ENTITY: odometer_readings,
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

    valid = await estimate(
        [trip()],
        [reading("1999-01-01T09:50:00", 80), reading("1999-01-01T10:40:00", 70)],
        [reading("1999-01-01T09:50:00", 1000), reading("1999-01-01T10:40:00", 1050)],
    )
    assert valid["km_per_l"] == 10.0
    assert valid["data_sufficient"] is True
    assert valid["period_start"] == "19981231"
    assert valid["period_end"] == "19990101"
    assert valid["trips_considered"] == 1
    assert valid["fuel_samples_used"] == 2
    assert valid["odometer_samples_used"] == 2
    assert valid["estimated_distance"] == 50
    assert valid["estimated_liters"] == 5
    assert valid["search_window_days"] == 30
    assert valid["_recent_trips"][0]["estimated_km_per_l"] == 10.0
    assert valid["_recent_trips"][0]["estimated_liters"] == 5.0

    missing = await estimate(
        [trip()],
        [reading("1999-01-01T09:50:00", 80)],
        [reading("1999-01-01T09:50:00", 1000)],
    )
    assert missing["data_sufficient"] is False
    assert missing["km_per_l"] is None
    assert missing["trips_considered"] == 0

    stale = await estimate(
        [trip()],
        [reading("1999-01-01T04:00:00", 80), reading("1999-01-01T16:00:00", 70)],
        [reading("1999-01-01T04:00:00", 1000), reading("1999-01-01T16:00:00", 1050)],
    )
    assert stale["data_sufficient"] is False
    assert stale["maximum_sample_gap_hours"] == 4

    inconsistent = await estimate(
        [trip(distance=50)],
        [reading("1999-01-01T09:50:00", 80), reading("1999-01-01T10:40:00", 70)],
        [reading("1999-01-01T09:50:00", 1000), reading("1999-01-01T10:40:00", 1010)],
    )
    assert inconsistent["data_sufficient"] is False
    assert inconsistent["trips_considered"] == 0

    maximum_window = await estimate(
        [trip(distance=25)],
        [
            reading("1998-12-31T09:50:00", 80),
            reading("1998-12-31T10:40:00", 75),
            reading("1999-01-01T09:50:00", 75),
            reading("1999-01-01T10:40:00", 70),
        ],
        [
            reading("1998-12-31T09:50:00", 950),
            reading("1998-12-31T10:40:00", 975),
            reading("1999-01-01T09:50:00", 975),
            reading("1999-01-01T10:40:00", 1000),
        ],
        [trip_snapshot(trip("1998-12-31T10:00:00", distance=25) | {
            "date": "19981231", "start_time": "100000"
        })],
    )
    assert maximum_window["km_per_l"] == 10.0
    assert maximum_window["trips_available"] == 2
    assert maximum_window["trips_considered"] == 2
    assert maximum_window["period_start"] == "19981231"
    assert maximum_window["period_end"] == "19990101"

    print("vehicle_primary consumption estimate: 5 cenários aprovados.")


if __name__ == "__main__":
    asyncio.run(main())
