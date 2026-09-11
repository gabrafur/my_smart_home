#!/usr/bin/env python3
"""Regression checks for the explicit consolidated-location dashboard."""

from pathlib import Path
import unittest


HOMEASSISTANT = Path(__file__).resolve().parents[1]
DASHBOARD = HOMEASSISTANT / "dashboards" / "location.yaml"
CONFIGURATION = HOMEASSISTANT / "configuration.yaml"
PRESENCE_ZONES = HOMEASSISTANT / "packages" / "zonas_presenca.yaml"
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
        self.assertIn('("zone.", "person.")', component)
        self.assertIn('state.attributes.get("decision_owner") == "node_red"', component)
        self.assertIn("entity_id in person_sources and not node_red_location", component)
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
        self.assertEqual(
            dashboard.count(
                "selectattr('attributes.decision_owner', 'eq', 'node_red')"
            ),
            2,
        )
        self.assertIn("title: Last update by source", dashboard)
        self.assertIn("location_sources", dashboard)
        self.assertIn("source.last_updated", dashboard)
        self.assertIn("source.location_observed_at", dashboard)
        self.assertIn("source.reporting_fresh", dashboard)
        self.assertIn("source.position_fresh", dashboard)
        self.assertIn("Source reporting", dashboard)
        self.assertIn("Source not reporting", dashboard)
        self.assertIn("Position changed recently", dashboard)
        self.assertIn("Position unchanged", dashboard)
        self.assertIn("Source last reported", dashboard)
        self.assertNotIn("report_age", dashboard)
        self.assertNotIn("gps_age", dashboard)
        self.assertNotIn("4500", dashboard)
        self.assertNotIn("10800", dashboard)
        self.assertNotIn("900", dashboard)
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

    def test_node_red_owns_machine_state_and_decision_radii(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")
        zones = PRESENCE_ZONES.read_text(encoding="utf-8")

        self.assertIn("item.state == 'near_home'", dashboard)
        self.assertIn("item.attributes.home_radius_m", dashboard)
        self.assertIn("item.attributes.near_home_radius_m", dashboard)
        self.assertNotIn("distance(", dashboard)
        self.assertIn("name: location_update_ring", zones)
        self.assertIn("radius: 1500", zones)
        self.assertNotIn("name: near_home", zones)


if __name__ == "__main__":
    unittest.main()
