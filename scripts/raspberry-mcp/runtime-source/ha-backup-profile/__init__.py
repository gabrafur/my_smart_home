"""Opt-in, admin-only backup metadata. Source candidate, not auto-installed."""
from __future__ import annotations

import probatio
from homeassistant.components import websocket_api
from homeassistant.components.backup.const import DATA_MANAGER
from homeassistant.core import callback

from .projection import project_profile

DOMAIN = "metadata_backup_profile"
METHOD = "backup/metadata_profile"
CONFIG_SCHEMA = probatio.Schema(
    {probatio.Optional(DOMAIN): probatio.Schema({})}, extra=probatio.ALLOW_EXTRA
)


@callback
@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): METHOD})
def handle_profile(hass, connection, message):
    """Return selected facts, never raw config, storage, keys or exceptions."""
    if (type(message) is not dict or set(message) != {"id", "type"}
            or type(message["id"]) is not int or message["id"] < 1
            or message["type"] != METHOD):
        connection.send_error(
            message.get("id") if type(message) is dict else None,
            "invalid_format", "Backup metadata request is invalid",
        )
        return
    try:
        result = project_profile(
            hass.data[DATA_MANAGER], hass.config_entries.async_entries("onedrive")
        )
    except Exception:
        connection.send_error(
            message["id"], "backup_profile_unavailable",
            "Backup metadata profile is unavailable",
        )
        return
    connection.send_result(message["id"], result)


async def async_setup(hass, config):
    if DOMAIN not in config:
        return False
    websocket_api.async_register_command(hass, handle_profile)
    return True
