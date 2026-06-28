"""Tuya Vacuum Maps integration."""

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant

from .const import DOMAIN

PLATFORMS = [Platform.CAMERA]

_LOGGER = logging.getLogger(__name__)
logging.getLogger("tuya_vacuum").setLevel(logging.DEBUG)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Tuya Vacuum Maps from a config entry."""

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = entry

    # Create each HA object for each plaform the device requires.
    # It's done by calling the `async_setup_entry` function in each platform module.
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""

    # This is called when an entry/configured device is to be removed.
    # The class needs to unload itself and remove callbacks.
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
