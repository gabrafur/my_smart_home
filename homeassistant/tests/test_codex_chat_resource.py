"""Regression contract for loading the Codex dashboard custom card."""

from __future__ import annotations

import hashlib
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONFIGURATION = ROOT / "homeassistant" / "configuration.yaml"
DASHBOARD = ROOT / "homeassistant" / "dashboards" / "chat.yaml"
CARD = ROOT / "homeassistant" / "www" / "codex-chat-card-v2.js"


class CodexChatResourceTest(unittest.TestCase):
    def test_card_is_registered_as_a_lovelace_yaml_resource(self):
        configuration = CONFIGURATION.read_text(encoding="utf-8")

        self.assertIn("resource_mode: yaml", configuration)
        self.assertRegex(
            configuration,
            r"(?m)^\s+- url: /local/codex-chat-card-v2\.js\?v=[0-9a-f]{12}\n"
            r"\s+type: module$",
        )
        self.assertNotRegex(
            configuration,
            r"(?s)extra_module_url:.*codex-chat-card-v2\.js",
        )

    def test_resource_version_matches_the_card_content_hash(self):
        configuration = CONFIGURATION.read_text(encoding="utf-8")
        match = re.search(
            r"/local/codex-chat-card-v2\.js\?v=([0-9a-f]{12})",
            configuration,
        )

        self.assertIsNotNone(match)
        expected = hashlib.sha256(CARD.read_bytes()).hexdigest()[:12]
        self.assertEqual(match.group(1), expected)

    def test_dashboard_uses_the_registered_card(self):
        dashboard = DASHBOARD.read_text(encoding="utf-8")

        self.assertIn("type: custom:codex-chat-card-v2", dashboard)
        self.assertTrue(CARD.is_file())


if __name__ == "__main__":
    unittest.main()
