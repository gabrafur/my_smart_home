"""Native iCloud integration with explicitly requested OTP delivery only.

All platforms and runtime behavior remain provided by Home Assistant Core.
Only this integration's two client factories are replaced before setup.
"""

from homeassistant.components.icloud import account as core_account
from homeassistant.components.icloud import config_flow as core_config_flow
from homeassistant.components.icloud import (
    CONFIG_SCHEMA,
    async_setup,
    async_setup_entry,
    async_unload_entry,
)

from .manual_auth import ManualOtpService

core_account.PyiCloudService = ManualOtpService
core_config_flow.PyiCloudService = ManualOtpService

__all__ = ["CONFIG_SCHEMA", "async_setup", "async_setup_entry", "async_unload_entry"]
