"""Native iCloud integration with explicitly requested OTP delivery only.

All platforms and runtime behavior remain provided by Home Assistant Core.
Only this integration's two client factories are replaced before setup.
"""

from homeassistant.components.icloud import account as core_account
from homeassistant.components.icloud import config_flow as core_config_flow
from homeassistant.components.icloud import (
    CONFIG_SCHEMA,
    async_setup,
    async_setup_entry as core_async_setup_entry,
    async_unload_entry,
)
from homeassistant.exceptions import ConfigEntryNotReady

from .manual_auth import ManualOtpService
from .setup_retry import is_transport_failure

core_account.PyiCloudService = ManualOtpService
core_config_flow.PyiCloudService = ManualOtpService


async def async_setup_entry(hass, entry):
    """Let HA retry a transient transport failure during native setup."""
    try:
        return await core_async_setup_entry(hass, entry)
    except Exception as err:
        if not is_transport_failure(err):
            raise
        raise ConfigEntryNotReady("iCloud transport unavailable during setup") from err


__all__ = ["CONFIG_SCHEMA", "async_setup", "async_setup_entry", "async_unload_entry"]
