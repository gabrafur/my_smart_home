"""Synchronous iCloud protocol operations, called only in an executor."""

from typing import Any


def refresh_devices(api: Any) -> bool:
    """Resolve the lazy Find My manager and refresh it off the event loop."""
    # api.devices is a property that can itself perform an HTTP request.
    manager = getattr(api, "devices", None)
    refresh = getattr(manager, "refresh", None)
    if not callable(refresh):
        return False
    refresh(True)
    return True
