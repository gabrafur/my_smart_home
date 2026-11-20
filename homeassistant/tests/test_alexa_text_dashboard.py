"""Regression tests for the Casa dashboard "Falar na Alexa" section."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "homeassistant" / "dashboards" / "casa.yaml"
CHAT = ROOT / "homeassistant" / "dashboards" / "chat.yaml"
PACKAGE = ROOT / "homeassistant" / "packages" / "alexa_text_announcements.yaml"


class AlexaTextDashboardTest(unittest.TestCase):
    def test_dashboard_exposes_text_field_and_explicit_send_button(self) -> None:
        dashboard = DASHBOARD.read_text(encoding="utf-8")
        self.assertIn("heading: Falar na Alexa", dashboard)
        self.assertNotIn("alexa_mensagem", CHAT.read_text(encoding="utf-8"))
        self.assertIn("entity: input_text.alexa_mensagem", dashboard)
        self.assertIn("perform_action: button.press", dashboard)
        self.assertIn("entity_id: button.ler_mensagem_na_alexa", dashboard)

    def test_quick_phrases_only_fill_the_draft(self) -> None:
        dashboard = DASHBOARD.read_text(encoding="utf-8")
        self.assertGreaterEqual(dashboard.count("perform_action: input_text.set_value"), 3)
        # A quick phrase never speaks by itself: only the explicit button does.
        self.assertEqual(dashboard.count("perform_action: button.press\n              target:\n                entity_id: button.ler_mensagem_na_alexa"), 1)

    def test_helper_only_publishes_an_intent_for_node_red(self) -> None:
        package = PACKAGE.read_text(encoding="utf-8")
        self.assertIn("max: 255", package)
        self.assertIn("event: alexa_text_announcement_requested", package)
        self.assertIn('message: "{{ mensagem }}"', package)
        self.assertRegex(package, r"mensagem \| length > 0")
        # The draft is cleared only after the event carries the message.
        self.assertLess(package.index("event: alexa_text_announcement_requested"), package.index("action: input_text.set_value"))
        self.assertIn('value: ""', package)
        self.assertNotRegex(package, r"(?m)^\s+- (?:action|service): (?:notify|media_player|alexa_media)\.")


if __name__ == "__main__":
    unittest.main()
