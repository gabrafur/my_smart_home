"""Regression tests for the Claude Code Chat user allowlist."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
PERMISSIONS = (
    ROOT
    / "homeassistant"
    / "custom_components"
    / "claude_code_chat"
    / "permissions.py"
)
COMPONENT = PERMISSIONS.with_name("__init__.py")
CONFIG_FLOW = PERMISSIONS.with_name("config_flow.py")
SPEC = importlib.util.spec_from_file_location(
    "claude_code_chat_permissions", PERMISSIONS
)
assert SPEC is not None and SPEC.loader is not None
permissions = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(permissions)


class ClaudeCodeChatPermissionsTest(unittest.TestCase):
    def test_multiple_explicit_users_are_allowed_and_others_are_denied(self):
        allowed = permissions.normalize_allowed_user_ids(
            ["resident_primary", "resident_secondary"]
        )

        self.assertTrue(permissions.is_user_authorized("resident_primary", allowed))
        self.assertTrue(permissions.is_user_authorized("resident_secondary", allowed))
        self.assertFalse(permissions.is_user_authorized("guest", allowed))
        self.assertFalse(permissions.is_user_authorized(None, allowed))

    def test_legacy_single_user_is_preserved_during_migration(self):
        allowed = permissions.normalize_allowed_user_ids(None, "resident_primary")

        self.assertEqual(allowed, frozenset({"resident_primary"}))

    def test_blank_and_non_string_values_never_grant_access(self):
        allowed = permissions.normalize_allowed_user_ids(
            ["", "  ", None, 123, " resident_primary "]
        )

        self.assertEqual(allowed, frozenset({"resident_primary"}))

    def test_config_entry_migrates_and_options_reload_the_allowlist(self):
        component = COMPONENT.read_text(encoding="utf-8")
        config_flow = CONFIG_FLOW.read_text(encoding="utf-8")

        self.assertIn("async def async_migrate_entry", component)
        self.assertIn("data.pop(CONF_ALLOWED_USER_ID", component)
        self.assertIn("version=2", component)
        self.assertIn("VERSION = 2", config_flow)
        self.assertIn("OptionsFlowWithReload", config_flow)
        self.assertIn("multiple=True", config_flow)
        self.assertNotIn("user.is_admin", config_flow)


if __name__ == "__main__":
    unittest.main()
