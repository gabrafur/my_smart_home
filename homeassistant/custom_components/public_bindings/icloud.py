"""Synchronous iCloud protocol operations, called only in an executor."""

from http.client import RemoteDisconnected
from typing import Any


def is_interrupted_transport(error: BaseException) -> bool:
    """Recognize a closed HTTP connection, never infer it from provider text."""
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        if isinstance(error, RemoteDisconnected):
            return True
        error = error.__cause__ or error.__context__
    return False


def refresh_devices(api: Any) -> bool:
    """Resolve the lazy Find My manager and refresh it off the event loop."""
    # api.devices is a property that can itself perform an HTTP request.
    manager = getattr(api, "devices", None)
    refresh = getattr(manager, "refresh", None)
    if not callable(refresh):
        return False
    refresh(True)
    return True
