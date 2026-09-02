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
        component = SYNC_COMPONENT.read_text(encoding="utf-8")

        self.assertIn("show_all: true", dashboard)
        self.assertNotIn("          - entity:", dashboard)
        self.assertIn("cluster: false", dashboard)
        self.assertIn("hours_to_show: 0", dashboard)
        self.assertIn('entity_id.startswith("zone.")', component)
        self.assertIn('hass.bus.async_listen(EVENT_STATE_CHANGED', component)
        self.assertIn("EVENT_ENTITY_REGISTRY_UPDATED", component)
        self.assertIn('map_card["entities"] = list(entity_ids)', component)

    def test_status_and_source_are_combined_and_freshness_stays_separate(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")

        self.assertEqual(dashboard.count("content: |-"), 2)
        self.assertNotIn("content: >-", dashboard)
        self.assertIn("title: Current status and source", dashboard)
        self.assertIn("item.state", dashboard)
        self.assertEqual(
            dashboard.count(
                "selectattr('attributes.selected_location_source', 'defined')"
            ),
            1,
        )
        self.assertIn("selected_location_source", dashboard)
        self.assertIn("title: Last update by source", dashboard)
        self.assertIn("location_sources", dashboard)
        self.assertIn("source.last_updated", dashboard)
        self.assertIn("source.location_observed_at", dashboard)
        self.assertIn("Source reporting", dashboard)
        self.assertIn("Source reporting late", dashboard)
        self.assertIn("Source not reporting", dashboard)
        self.assertIn("Position changed recently", dashboard)
        self.assertIn("Position unchanged", dashboard)
        self.assertIn("Source last reported", dashboard)
        self.assertNotIn("Stale GPS", dashboard)

    def test_dashboard_labels_are_english_only(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")

        self.assertIn("title: Map", dashboard)
        self.assertIn("heading: Live locations", dashboard)
        self.assertIn("heading: Source health", dashboard)
        self.assertNotIn("title: Mapa", dashboard)
        self.assertNotIn("Estado atual", dashboard)
        self.assertNotIn("Fonte em uso", dashboard)
        self.assertNotIn("Última atualização", dashboard)

    def test_dashboard_is_not_registered_as_a_second_sidebar_panel(self):
        configuration = CONFIGURATION.read_text(encoding="utf-8")

        self.assertNotIn("mapa-localizacao:", configuration)

    def test_native_map_uses_the_same_dashboard(self):
        configuration = CONFIGURATION.read_text(encoding="utf-8")
        component = SYNC_COMPONENT.read_text(encoding="utf-8")

        self.assertIn("consolidated_map:", configuration)
        self.assertIn("path: dashboards/location.yaml", configuration)
        self.assertIn('NATIVE_MAP_PATH = "map"', component)
        self.assertIn("await native_map.async_save(rendered)", component)
        self.assertIn('map_card.get("show_all") is not True', component)


if __name__ == "__main__":
    unittest.main()
