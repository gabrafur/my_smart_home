"""The Claude Code Chat integration."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import CONF_ALLOWED_USER_ID, CONF_BRIDGE_TOKEN, CONF_BRIDGE_URL

PLATFORMS = (Platform.CONVERSATION,)


@dataclass
class ClaudeCodeChatData:
    """Runtime data for a Claude Code Chat config entry."""

    bridge_url: str
    bridge_token: str
    allowed_user_id: str


type ClaudeCodeChatConfigEntry = ConfigEntry[ClaudeCodeChatData]


async def async_setup_entry(
    hass: HomeAssistant, entry: ClaudeCodeChatConfigEntry
) -> bool:
    """Set up Claude Code Chat from a config entry."""
    entry.runtime_data = ClaudeCodeChatData(
        bridge_url=entry.data[CONF_BRIDGE_URL],
        bridge_token=entry.data[CONF_BRIDGE_TOKEN],
        allowed_user_id=entry.data[CONF_ALLOWED_USER_ID],
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ClaudeCodeChatConfigEntry
) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
