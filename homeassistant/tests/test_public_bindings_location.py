#!/usr/bin/env python3
"""Regression checks for consolidated resident location selection."""

from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "custom_components"
    / "public_bindings"
    / "location.py"
)
COMPONENT_PATH = MODULE_PATH.with_name("__init__.py")
BINDINGS_EXAMPLE = (
    Path(__file__).resolve().parents[2]
    / "bindings"
    / "private-bindings.example.json"
)
SPEC = importlib.util.spec_from_file_location("public_bindings_location", MODULE_PATH)
assert SPEC and SPEC.loader
LOCATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCATION)
POLICY_PATH = MODULE_PATH.with_name("service_policy.py")
POLICY_SPEC = importlib.util.spec_from_file_location(
    "public_bindings_service_policy", POLICY_PATH
)
assert POLICY_SPEC and POLICY_SPEC.loader
POLICY = importlib.util.module_from_spec(POLICY_SPEC)
POLICY_SPEC.loader.exec_module(POLICY)

NOW = datetime(2026, 8, 30, 21, 0, tzinfo=timezone.utc)


def state(
    zone: str,
    *,
    age: timedelta = timedelta(0),
    accuracy: int | None = 10,
    coordinates: bool = True,
):
    attributes = {"gps_accuracy": accuracy, "source_type": "gps"}
    if coordinates:
        attributes.update({"latitude": -10.0, "longitude": -20.0})
    return SimpleNamespace(
        state=zone,
        attributes=attributes,
        last_updated=NOW - age,
    )


class BestLocationSelectionTest(unittest.TestCase):
    def test_hidden_targets_follow_late_entity_registration(self):
        component = COMPONENT_PATH.read_text(encoding="utf-8")
        self.assertIn("er.EVENT_ENTITY_REGISTRY_UPDATED", component)
        self.assertIn("hide_private_targets", component)

    def test_current_source_wins_over_stale_source(self):
        mobile_app = state("chegando", age=timedelta(days=3), accuracy=4)
        icloud = state("home", accuracy=25)

        self.assertIs(
            LOCATION.select_best_location([mobile_app, icloud], NOW), icloud
        )

    def test_reliable_coordinates_win(self):
        mobile_app = state("chegando", accuracy=999)
        icloud = state("home", accuracy=10)

        self.assertIs(
            LOCATION.select_best_location([mobile_app, icloud], NOW), icloud
        )

    def test_materially_newer_source_wins_before_accuracy(self):
        mobile_app = state("not_home", accuracy=50)
        icloud = state("home", age=timedelta(minutes=2), accuracy=4)

        self.assertIs(
            LOCATION.select_best_location([mobile_app, icloud], NOW), mobile_app
        )

    def test_accuracy_breaks_near_simultaneous_tie(self):
        mobile_app = state("chegando", age=timedelta(seconds=5), accuracy=10)
        icloud = state("home", accuracy=4)

        self.assertIs(
            LOCATION.select_best_location([mobile_app, icloud], NOW), icloud
        )

    def test_intermediate_sources_are_hidden_from_the_map(self):
        document = json.loads(BINDINGS_EXAMPLE.read_text(encoding="utf-8"))
        expected_strings = {"gps_accuracy", "latitude", "longitude"}

        for role, prefix in (
            ("resident_primary", "device_tracker.mobile_primary_source_"),
            ("resident_secondary", "device_tracker.mobile_secondary_source_"),
        ):
            entities = document["roles"][role]["entities"]
            for index in (1, 2):
                self.assertEqual(
                    set(entities[f"{prefix}{index}"]["string_attributes"]),
                    expected_strings,
                )
            self.assertNotIn(
                "string_attributes",
                entities[f"device_tracker.{role}_location"],
            )
            self.assertEqual(
                entities[f"device_tracker.{role}_location"]["source_names"],
                ["Home Assistant App", "iCloud"],
            )
            self.assertTrue(
                entities[f"device_tracker.{role}_location"]["display_name"]
            )
            self.assertIs(
                entities[f"device_tracker.{role}_location"]["hide_targets"],
                True,
            )

        vehicle_entities = document["roles"]["vehicle_primary"]["entities"]
        vehicle = vehicle_entities["device_tracker.vehicle_primary"]
        self.assertEqual(vehicle["source_names"], ["Bluelink"])
        self.assertTrue(vehicle["display_name"])
        self.assertTrue(vehicle_entities)
        for binding in vehicle_entities.values():
            self.assertIs(binding["hide_targets"], True)


class ServicePolicyTest(unittest.TestCase):
    def test_location_refresh_is_dispatched_without_waiting(self):
        self.assertTrue(
            POLICY.is_best_effort_notification(
                "notify", {"message": "request_location_update"}
            )
        )

    def test_regular_notification_remains_blocking(self):
        self.assertFalse(
            POLICY.is_best_effort_notification(
                "notify", {"message": "Portão aberto"}
            )
        )

    def test_non_notification_service_remains_blocking(self):
        self.assertFalse(
            POLICY.is_best_effort_notification(
                "script", {"message": "request_location_update"}
            )
        )

    def test_non_string_message_remains_blocking(self):
        self.assertFalse(
            POLICY.is_best_effort_notification(
                "notify", {"message": {"command": "request_location_update"}}
            )
        )


if __name__ == "__main__":
    unittest.main()
