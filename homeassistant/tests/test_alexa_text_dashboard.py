"""Regression tests for the Chat dashboard Alexa text announcement view."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "homeassistant" / "dashboards" / "chat.yaml"
PACKAGE = ROOT / "homeassistant" / "packages" / "alexa_text_announcements.yaml"


class AlexaTextDashboardTest(unittest.TestCase):
    def test_dashboard_exposes_text_field_and_explicit_send_button(self) -> None:
        dashboard = DASHBOARD.read_text(encoding="utf-8")
        self.assertRegex(dashboard, r"(?m)^  - title: Alexa$")
        self.assertRegex(dashboard, r"(?m)^    path: alexa$")
        self.assertIn("entity: input_text.alexa_mensagem", dashboard)
        self.assertIn("perform_action: button.press", dashboard)
        self.assertIn("entity_id: button.ler_mensagem_na_alexa", dashboard)

    def test_helper_only_publishes_an_intent_for_node_red(self) -> None:
        package = PACKAGE.read_text(encoding="utf-8")
        self.assertIn("max: 255", package)
        self.assertIn("event: alexa_text_announcement_requested", package)
        self.assertIn('message: "{{ mensagem }}"', package)
        self.assertRegex(package, r"mensagem \| length > 0")
        self.assertNotRegex(package, r"(?m)^\s+- (?:action|service): (?:notify|media_player|alexa_media)\.")


if __name__ == "__main__":
    unittest.main()
