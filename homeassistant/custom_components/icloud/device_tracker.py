"""Delegate device tracking to Home Assistant's native iCloud platform."""
from homeassistant.components.icloud.device_tracker import async_setup_entry

__all__ = ["async_setup_entry"]
