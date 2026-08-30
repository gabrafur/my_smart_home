#!/usr/bin/env python3
"""Regression checks for the explicit consolidated-location dashboard."""

from pathlib import Path
import re
import unittest


HOMEASSISTANT = Path(__file__).resolve().parents[1]
DASHBOARD = HOMEASSISTANT / "dashboards" / "location.yaml"
CONFIGURATION = HOMEASSISTANT / "configuration.yaml"


class LocationDashboardTest(unittest.TestCase):
    def test_dashboard_uses_only_consolidated_locations(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")
        map_block, entity_list = dashboard.split("      - type: entities", 1)
        expected = {
            "device_tracker.resident_primary_location",
            "device_tracker.resident_secondary_location",
            "device_tracker.vehicle_primary",
        }

        self.assertEqual(
            set(re.findall(r"entity: (device_tracker\.[a-z0-9_]+)", map_block)),
            expected,
        )
        self.assertEqual(
            set(re.findall(r"entity: (device_tracker\.[a-z0-9_]+)", entity_list)),
            expected,
        )
        self.assertNotIn("mobile_primary_source", dashboard)
        self.assertNotIn("mobile_secondary_source", dashboard)
        self.assertIn("cluster: false", dashboard)
        self.assertIn("hours_to_show: 0", dashboard)

    def test_private_names_and_vehicle_label_are_preserved(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")

        self.assertEqual(dashboard.count("!secret resident_primary_display_name"), 2)
        self.assertEqual(dashboard.count("!secret resident_secondary_display_name"), 2)
        self.assertEqual(dashboard.count("name: Creta"), 2)

    def test_dashboard_is_registered_in_sidebar(self):
        configuration = CONFIGURATION.read_text(encoding="utf-8")

        self.assertIn("mapa-localizacao:", configuration)
        self.assertIn("title: Localização", configuration)
        self.assertIn("filename: dashboards/location.yaml", configuration)


if __name__ == "__main__":
    unittest.main()
