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

# Home Assistant user "Gabriel" (system-admin), read from /config/.storage/auth
# at the time this integration was set up. Shown as the default so setup is a
# one-click confirm, but it stays editable in case the user id ever changes.
DEFAULT_ALLOWED_USER_ID = "4c8256f7470a4bb1a79421a76f43fdc4"

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_BRIDGE_URL, default=DEFAULT_BRIDGE_URL): str,
        vol.Required(CONF_BRIDGE_TOKEN): str,
        vol.Required(
            CONF_ALLOWED_USER_ID, default=DEFAULT_ALLOWED_USER_ID
        ): str,
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
