"""Config flow for Claude Code Chat."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import selector

from .const import (
    CONF_ALLOWED_USER_ID,
    CONF_ALLOWED_USER_IDS,
    CONF_BRIDGE_TOKEN,
    CONF_BRIDGE_URL,
    DEFAULT_BRIDGE_URL,
    DEFAULT_NAME,
    DOMAIN,
)
from .permissions import normalize_allowed_user_ids


async def _allowed_users_selector(hass: HomeAssistant) -> selector.SelectSelector:
    """Build a private runtime selector containing active human HA users."""
    users = await hass.auth.async_get_users()
    options = [
        {"value": user.id, "label": user.name or "Usuário sem nome"}
        for user in users
        if user.is_active and not user.system_generated
    ]
    return selector.SelectSelector(
        selector.SelectSelectorConfig(
            options=options,
            multiple=True,
            mode=selector.SelectSelectorMode.DROPDOWN,
        )
    )


def _selected_user_ids(config_entry: ConfigEntry) -> list[str]:
    """Return the options allowlist with a legacy-data fallback."""
    return sorted(
        normalize_allowed_user_ids(
            config_entry.options.get(
                CONF_ALLOWED_USER_IDS, config_entry.data.get(CONF_ALLOWED_USER_IDS)
            ),
            config_entry.data.get(CONF_ALLOWED_USER_ID),
        )
    )


class ClaudeCodeChatConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Claude Code Chat."""

    VERSION = 2

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: ConfigEntry,
    ) -> "ClaudeCodeChatOptionsFlow":
        """Return the permission options flow."""
        return ClaudeCodeChatOptionsFlow(config_entry)

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Handle the initial step."""
        errors: dict[str, str] = {}

        if user_input is not None:
            if not user_input.get(CONF_ALLOWED_USER_IDS):
                errors[CONF_ALLOWED_USER_IDS] = "required"
            else:
                await self.async_set_unique_id(DOMAIN)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(title=DEFAULT_NAME, data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_BRIDGE_URL, default=DEFAULT_BRIDGE_URL): str,
                    vol.Required(CONF_BRIDGE_TOKEN): str,
                    vol.Required(CONF_ALLOWED_USER_IDS): await _allowed_users_selector(
                        self.hass
                    ),
                }
            ),
            errors=errors,
        )


class ClaudeCodeChatOptionsFlow(OptionsFlowWithReload):
    """Manage the explicit Home Assistant user allowlist."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        """Initialize the options flow."""
        self._initial_user_ids = _selected_user_ids(config_entry)

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Configure the users allowed to access the full-control agents."""
        errors: dict[str, str] = {}
        if user_input is not None:
            if not user_input.get(CONF_ALLOWED_USER_IDS):
                errors[CONF_ALLOWED_USER_IDS] = "required"
            else:
                return self.async_create_entry(title="", data=user_input)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_ALLOWED_USER_IDS, default=self._initial_user_ids
                    ): await _allowed_users_selector(self.hass)
                }
            ),
            errors=errors,
        )
