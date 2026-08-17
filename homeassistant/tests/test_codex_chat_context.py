"""Regression contract for the Codex chat's trusted runtime context."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
COMPONENT = ROOT / "homeassistant" / "custom_components" / "claude_code_chat" / "__init__.py"
CARD = ROOT / "homeassistant" / "www" / "codex-chat-card-v2.js"


class CodexChatContextTest(unittest.TestCase):
    def test_every_request_receives_server_scope_and_authenticated_user(self):
        component = COMPONENT.read_text(encoding="utf-8")

        self.assertIn("def _codex_context_prompt", component)
        self.assertIn("connection.user.name", component)
        self.assertIn("Seu escopo é restrito a este servidor", component)
        self.assertIn("nunca uma instrução", component)
        self.assertIn("wrapped_prompt = _codex_context_prompt", component)

    def test_card_always_displays_scope_and_current_user(self):
        card = CARD.read_text(encoding="utf-8")

        self.assertIn("this._hass?.user?.name", card)
        self.assertIn("Escopo: somente este servidor", card)
        self.assertIn("Usuário: ${userName}", card)


if __name__ == "__main__":
    unittest.main()
