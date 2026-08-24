"""Permission helpers for Claude Code Chat."""

from __future__ import annotations

from collections.abc import Iterable


def normalize_allowed_user_ids(
    configured_user_ids: object, legacy_user_id: object = None
) -> frozenset[str]:
    """Return a sanitized allowlist while preserving the legacy user id."""
    if isinstance(configured_user_ids, str):
        candidates: Iterable[object] = (configured_user_ids,)
    elif isinstance(configured_user_ids, (list, tuple, set, frozenset)):
        candidates = configured_user_ids
    elif isinstance(legacy_user_id, str):
        candidates = (legacy_user_id,)
    else:
        candidates = ()

    return frozenset(
        user_id.strip()
        for user_id in candidates
        if isinstance(user_id, str) and user_id.strip()
    )


def is_user_authorized(
    user_id: str | None, allowed_user_ids: frozenset[str]
) -> bool:
    """Return whether an authenticated Home Assistant user is allowlisted."""
    return user_id is not None and user_id in allowed_user_ids
