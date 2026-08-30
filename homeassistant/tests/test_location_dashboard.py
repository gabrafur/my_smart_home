#!/usr/bin/env python3
"""Regression checks for the explicit consolidated-location dashboard."""

from pathlib import Path
import unittest


HOMEASSISTANT = Path(__file__).resolve().parents[1]
DASHBOARD = HOMEASSISTANT / "dashboards" / "location.yaml"
CONFIGURATION = HOMEASSISTANT / "configuration.yaml"
SYNC_COMPONENT = (
    HOMEASSISTANT / "custom_components" / "consolidated_map" / "__init__.py"
)


class LocationDashboardTest(unittest.TestCase):
    def test_dashboard_automatically_includes_location_entities(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")

        self.assertIn("show_all: true", dashboard)
        self.assertNotIn("          - entity:", dashboard)
        self.assertIn("cluster: false", dashboard)
        self.assertIn("hours_to_show: 0", dashboard)

    def test_source_selection_and_freshness_have_separate_cards(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")

        self.assertIn("title: Estado atual", dashboard)
        self.assertIn("item.state", dashboard)
        self.assertGreaterEqual(
            dashboard.count(
                "selectattr('attributes.selected_location_source', 'defined')"
            ),
            2,
        )
        self.assertIn("title: Fonte em uso", dashboard)
        self.assertIn("selected_location_source", dashboard)
        self.assertIn("title: Última atualização de cada fonte", dashboard)
        self.assertIn("location_sources", dashboard)
        self.assertIn("source.last_updated", dashboard)

    def test_dashboard_is_not_registered_as_a_second_sidebar_panel(self):
        configuration = CONFIGURATION.read_text(encoding="utf-8")

        self.assertNotIn("mapa-localizacao:", configuration)

    def test_native_map_uses_the_same_dashboard(self):
        configuration = CONFIGURATION.read_text(encoding="utf-8")
        component = SYNC_COMPONENT.read_text(encoding="utf-8")

        self.assertIn("consolidated_map:", configuration)
        self.assertIn("path: dashboards/location.yaml", configuration)
        self.assertIn('NATIVE_MAP_PATH = "map"', component)
        self.assertIn("await native_map.async_save(dashboard)", component)
        self.assertIn('map_card.get("show_all") is not True', component)


if __name__ == "__main__":
    unittest.main()
