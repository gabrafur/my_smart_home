#!/usr/bin/env python3
"""Regression checks for consolidated resident location selection."""

from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "custom_components"
    / "public_bindings"
    / "location.py"
)
SPEC = importlib.util.spec_from_file_location("public_bindings_location", MODULE_PATH)
assert SPEC and SPEC.loader
LOCATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCATION)

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


if __name__ == "__main__":
    unittest.main()
