"""Location-source selection shared by public binding projections."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import inf, isfinite
from typing import Any, Protocol, Sequence

LOCATION_FRESHNESS = timedelta(minutes=15)
FUTURE_TOLERANCE = timedelta(minutes=1)
RECENCY_TIE = timedelta(minutes=1)
MAX_GPS_ACCURACY_METERS = 100
INVALID_STATES = {"", "unknown", "unavailable"}


class LocationState(Protocol):
    """Minimal Home Assistant state interface used by the selector."""

    state: str
    attributes: dict[str, Any]
    last_updated: datetime


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _has_reliable_coordinates(state: LocationState) -> bool:
    latitude = _number(state.attributes.get("latitude"))
    longitude = _number(state.attributes.get("longitude"))
    accuracy = _number(state.attributes.get("gps_accuracy"))
    return (
        latitude is not None
        and longitude is not None
        and (accuracy is None or accuracy <= MAX_GPS_ACCURACY_METERS)
    )


def _is_fresh(state: LocationState, now: datetime) -> bool:
    observed_at = state.last_updated
    return (
        observed_at <= now + FUTURE_TOLERANCE
        and now - observed_at <= LOCATION_FRESHNESS
    )


def _accuracy(state: LocationState) -> float:
    accuracy = _number(state.attributes.get("gps_accuracy"))
    return accuracy if accuracy is not None and accuracy >= 0 else inf


def select_best_location(
    states: Sequence[LocationState], now: datetime | None = None
) -> LocationState | None:
    """Select the best source using the same priorities as Node-RED."""
    if not states:
        return None

    current = now or datetime.now(timezone.utc)
    selected = states[0]

    for candidate in states[1:]:
        selected_fresh = _is_fresh(selected, current)
        candidate_fresh = _is_fresh(candidate, current)
        if selected_fresh != candidate_fresh:
            if candidate_fresh:
                selected = candidate
            continue

        selected_coordinates = _has_reliable_coordinates(selected)
        candidate_coordinates = _has_reliable_coordinates(candidate)
        if selected_coordinates != candidate_coordinates:
            if candidate_coordinates:
                selected = candidate
            continue

        recency_delta = candidate.last_updated - selected.last_updated
        if abs(recency_delta) > RECENCY_TIE:
            if recency_delta > timedelta(0):
                selected = candidate
            continue

        selected_accuracy = _accuracy(selected)
        candidate_accuracy = _accuracy(candidate)
        if selected_accuracy != candidate_accuracy:
            if candidate_accuracy < selected_accuracy:
                selected = candidate
            continue

        if candidate.last_updated != selected.last_updated:
            if candidate.last_updated > selected.last_updated:
                selected = candidate
            continue

        selected_valid = selected.state not in INVALID_STATES
        candidate_valid = candidate.state not in INVALID_STATES
        if selected_valid != candidate_valid and candidate_valid:
            selected = candidate

    return selected
