"""Execution policy for services exposed through public bindings."""

from __future__ import annotations

from typing import Any


BEST_EFFORT_NOTIFICATION_MESSAGES = frozenset(
    {
        "clear_notification",
        "request_location_update",
    }
)


def is_best_effort_notification(domain: str, data: dict[str, Any]) -> bool:
    """Return whether a notification must be dispatched without awaiting it."""
    message = data.get("message")
    return (
        domain == "notify"
        and isinstance(message, str)
        and message in BEST_EFFORT_NOTIFICATION_MESSAGES
    )
