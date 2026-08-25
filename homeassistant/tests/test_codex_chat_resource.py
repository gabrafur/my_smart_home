"""Regression contract for loading the Codex dashboard custom card."""

from __future__ import annotations

import ast
import hashlib
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONFIGURATION = ROOT / "homeassistant" / "configuration.yaml"
DASHBOARD = ROOT / "homeassistant" / "dashboards" / "chat.yaml"
CARD = ROOT / "homeassistant" / "www" / "codex-chat-card-v2.js"
COMPONENT = ROOT / "homeassistant" / "custom_components" / "claude_code_chat" / "__init__.py"
BEHAVIOR_TEST = ROOT / "homeassistant" / "tests" / "codex_chat_card_behavior.test.mjs"


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

    def test_messages_are_copyable_and_work_reports_elapsed_time(self):
        card = CARD.read_text(encoding="utf-8")

        self.assertIn("user-select:text", card)
        self.assertIn("-webkit-touch-callout:default", card)
        self.assertIn("loadingMessage()", card)
        self.assertIn("Ainda trabalhando", card)
        self.assertIn("gpt-5.6-luna", card)

    def test_mobile_layout_uses_available_dynamic_viewport_and_one_scroll_owner(self):
        card = CARD.read_text(encoding="utf-8")

        self.assertIn("height:100%", card)
        self.assertIn("100dvh", card)
        self.assertIn("window.visualViewport", card)
        self.assertIn("grid-template-rows:auto minmax(0,1fr) auto auto", card)
        self.assertIn(".feed{min-height:0;overflow-y:auto", card)
        self.assertIn("env(safe-area-inset-bottom,0px)", card)
        self.assertIn("overscroll-behavior:contain", card)
        self.assertNotIn("height:min(58vh", card)
        self.assertNotIn("min-height:320px", card)
        self.assertNotIn("min-height:280px", card)

    def test_persistence_behavior_contract(self):
        result = subprocess.run(
            ["node", "--test", str(BEHAVIOR_TEST)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_model_and_reasoning_options_match_websocket_validation(self):
        card = CARD.read_text(encoding="utf-8")
        component = COMPONENT.read_text(encoding="utf-8")
        frontend_match = re.search(r"const MODELS = (\{.*?\n\});", card, re.DOTALL)
        self.assertIsNotNone(frontend_match)
        frontend_models = ast.literal_eval(frontend_match.group(1))

        assignments = {}
        for node in ast.walk(ast.parse(component)):
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                if node.targets[0].id in {"CODEX_MODELS", "DEFAULT_CODEX_MODEL", "DEFAULT_CODEX_REASONING_EFFORT"}:
                    assignments[node.targets[0].id] = ast.literal_eval(node.value)

        self.assertEqual(
            {model: set(efforts) for model, efforts in frontend_models.items()},
            assignments["CODEX_MODELS"],
        )
        default_match = re.search(
            r"DEFAULT_SETTINGS = Object\.freeze\(\{ model: '([^']+)', reasoning: '([^']+)' \}\)",
            card,
        )
        self.assertIsNotNone(default_match)
        self.assertEqual(default_match.group(1), assignments["DEFAULT_CODEX_MODEL"])
        self.assertEqual(default_match.group(2), assignments["DEFAULT_CODEX_REASONING_EFFORT"])


if __name__ == "__main__":
    unittest.main()
