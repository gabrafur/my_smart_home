"""Config flow for Claude Code Chat."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import (
    CONF_ALLOWED_USER_ID,
    CONF_BRIDGE_TOKEN,
    CONF_BRIDGE_URL,
    DEFAULT_BRIDGE_URL,
    DEFAULT_NAME,
    DOMAIN,
)

# The single Home Assistant user id allowed to talk to this conversation agent.
# Deliberately NOT defaulted to a real id: this repository is public, and the
# HA user id is an account identifier that belongs in the config entry (stored
# under .storage/, which is never versioned) and not in source. Read it from
# /config/.storage/auth ("users" -> "id") and paste it during setup.
STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_BRIDGE_URL, default=DEFAULT_BRIDGE_URL): str,
        vol.Required(CONF_BRIDGE_TOKEN): str,
        vol.Required(CONF_ALLOWED_USER_ID): str,
    }
)


class ClaudeCodeChatConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Claude Code Chat."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            await self.async_set_unique_id(DOMAIN)
            self._abort_if_unique_id_configured()
            return self.async_create_entry(title=DEFAULT_NAME, data=user_input)

        return self.async_show_form(
            step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors
        )
