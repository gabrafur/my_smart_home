"""Regression contract for the Casa (daily) and Sistema (admin) dashboards."""

from pathlib import Path
import re
import unittest


HOMEASSISTANT = Path(__file__).resolve().parents[1]
DASHBOARDS = HOMEASSISTANT / "dashboards"
CASA = DASHBOARDS / "casa.yaml"
SISTEMA = DASHBOARDS / "sistema.yaml"
CONFIGURATION = HOMEASSISTANT / "configuration.yaml"
THEME = HOMEASSISTANT / "themes" / "casa.yaml"

# Household controls that lived in the old Overview favorites.
HOUSEHOLD_CONTROLS = (
    "climate.ar_condicionado_escritorio",
    "media_player.samsung_qn90ba_50_qn50qn90bagxzd",
    "alarm_control_panel.alarme_moni_mobile",
    "button.acionar_portao_da_garagem",
    "vacuum.lds_robot",
    "switch.lampadas_garagem",
    "switch.lampada_varanda",
    "switch.refletores_jardim",
    "switch.abajour_sala_de_estar",
    "switch.refletor_portao_carros",
    "number.paf_a07_feed",
)
SERVER_COMMANDS = (
    "script.pc_desligar",
    "script.pc_reiniciar",
    "script.raspberry_desligar",
    "script.raspberry_reiniciar",
)


def tile_blocks(text: str, entity: str) -> list[str]:
    """Return every card block (from its '- type:' line) that names the entity."""
    blocks = re.split(r"(?m)^(?=\s+- type: )", text)
    return [block for block in blocks if f"entity: {entity}\n" in block]


class CasaDashboardTest(unittest.TestCase):
    def test_dashboards_are_registered_with_the_right_audience(self) -> None:
        configuration = CONFIGURATION.read_text(encoding="utf-8")
        casa = configuration[configuration.index("    painel-casa:"):]
        sistema = configuration[configuration.index("    painel-sistema:"):]
        self.assertIn("filename: dashboards/casa.yaml", casa.split("\n    painel-sistema:")[0])
        self.assertNotIn("require_admin", casa.split("\n    painel-sistema:")[0])
        self.assertIn("require_admin: true", sistema)
        self.assertIn("filename: dashboards/sistema.yaml", sistema)
        for retired in ("house-status:", "raspberry-pi-system-health:"):
            self.assertNotIn(retired, configuration)

    def test_household_controls_are_preserved(self) -> None:
        casa = CASA.read_text(encoding="utf-8")
        for entity in HOUSEHOLD_CONTROLS:
            with self.subTest(entity=entity):
                self.assertIn(f"entity: {entity}\n", casa)

    def test_server_commands_live_only_in_the_admin_dashboard_and_confirm(self) -> None:
        casa = CASA.read_text(encoding="utf-8")
        sistema = SISTEMA.read_text(encoding="utf-8")
        for entity in SERVER_COMMANDS:
            with self.subTest(entity=entity):
                self.assertNotIn(entity, casa)
                blocks = tile_blocks(sistema, entity)
                self.assertEqual(len(blocks), 1)
                self.assertIn("confirmation:", blocks[0])

    def test_gate_always_confirms(self) -> None:
        casa = CASA.read_text(encoding="utf-8")
        blocks = tile_blocks(casa, "button.acionar_portao_da_garagem")
        self.assertGreaterEqual(len(blocks), 3)
        for block in blocks:
            self.assertIn("text: Acionar o portão da garagem?", block)

    def test_alarm_and_car_lock_never_act_from_a_tap(self) -> None:
        casa = CASA.read_text(encoding="utf-8")
        for block in tile_blocks(casa, "alarm_control_panel.alarme_moni_mobile"):
            self.assertNotIn("perform_action", block)
        for block in tile_blocks(casa, "lock.vehicle_primary_door_lock"):
            self.assertNotIn("perform_action", block)
            self.assertIn("navigation_path: /creta-viagens", block)
        for block in tile_blocks(casa, "switch.rele_acionador_portao"):
            self.assertIn("action: none", block)

    def test_technical_alerts_stay_out_of_the_household_dashboard(self) -> None:
        casa = CASA.read_text(encoding="utf-8")
        sistema = SISTEMA.read_text(encoding="utf-8")
        self.assertNotIn("heading: Atenção", casa)
        self.assertIn("heading: Pede atenção", sistema)
        self.assertIn("binary_sensor.tuya_devices", sistema)

    def test_public_dashboards_use_role_entities_for_people(self) -> None:
        casa = CASA.read_text(encoding="utf-8")
        self.assertNotRegex(casa, r"\bperson\.")
        self.assertIn("device_tracker.resident_primary_location", casa)
        self.assertIn("device_tracker.resident_secondary_location", casa)
        self.assertNotIn("vehicle_primary_door_lock", casa.replace("lock.vehicle_primary_door_lock", ""))

    def test_theme_has_light_and_dark_modes(self) -> None:
        theme = THEME.read_text(encoding="utf-8")
        self.assertRegex(theme, r"(?m)^casa:$")
        self.assertIn("    light:", theme)
        self.assertIn("    dark:", theme)
        self.assertIn('primary-color: "#2b5f8a"', theme)


if __name__ == "__main__":
    unittest.main()
