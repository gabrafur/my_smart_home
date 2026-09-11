"""Location-source selection shared by public binding projections."""

from __future__ import annotations

from datetime import datetime, timezone
from math import isfinite
from typing import Any, NamedTuple, Protocol, Sequence

SOURCE_REPORTED_AT_ATTRIBUTE = "source_reported_at"


class LocationState(Protocol):
    """Minimal Home Assistant state interface used by the selector."""

    entity_id: str
    state: str
    attributes: dict[str, Any]
    last_changed: datetime
    last_updated: datetime


class LocationObservation(NamedTuple):
    """Last observable location payload and when it actually changed."""

    signature: tuple[str, float | None, float | None, float | None]
    observed_at: datetime


LocationObservations = dict[str, LocationObservation]
SourceReports = dict[str, datetime]


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _location_signature(
    state: LocationState,
) -> tuple[str, float | None, float | None, float | None]:
    """Return only fields that prove a location observation changed."""
    return (
        state.state,
        _number(state.attributes.get("latitude")),
        _number(state.attributes.get("longitude")),
        _number(state.attributes.get("gps_accuracy")),
    )


def update_location_observation(
    observations: LocationObservations,
    state: LocationState,
) -> bool:
    """Record a location change without treating battery updates as movement."""
    signature = _location_signature(state)
    previous = observations.get(state.entity_id)
    changed = previous is not None and previous.signature != signature
    observed_at = (
        state.last_updated
        if changed
        else previous.observed_at if previous is not None else state.last_changed
    )
    observations[state.entity_id] = LocationObservation(signature, observed_at)
    return changed


def location_observed_at(
    observations: LocationObservations,
    state: LocationState,
) -> datetime:
    """Return location-specific recency, conservatively seeding at startup."""
    observation = observations.get(state.entity_id)
    return observation.observed_at if observation is not None else state.last_changed


def source_reported_at(
    state: LocationState,
    reports: SourceReports | None = None,
) -> datetime:
    """Return the original source heartbeat through nested public aliases."""
    value = state.attributes.get(SOURCE_REPORTED_AT_ATTRIBUTE)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
        else:
            if parsed.tzinfo is not None:
                return parsed.astimezone(timezone.utc)
    if reports is not None and state.entity_id in reports:
        return reports[state.entity_id]
    return state.last_updated


def recover_source_reported_at(
    states: Sequence[LocationState],
    before: datetime,
) -> datetime | None:
    """Recover a pre-startup heartbeat without trusting restored state time."""
    candidates = [
        source_reported_at(state)
        for state in states
        if state.last_updated < before
    ]
    return max(candidates, default=None)


def recover_location_observation(
    states: Sequence[LocationState],
) -> LocationObservation | None:
    """Recover the last location-payload change from recorder history."""
    recovered: LocationObservation | None = None
    for state in states:
        signature = _location_signature(state)
        if recovered is None or recovered.signature != signature:
            recovered = LocationObservation(signature, state.last_updated)
    return recovered
