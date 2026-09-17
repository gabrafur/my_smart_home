"""Location-source selection shared by public binding projections."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
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

    signature: tuple[float, float, float | None]
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
) -> tuple[float, float, float | None] | None:
    """Return only coordinates that prove a location observation changed."""
    latitude = _number(state.attributes.get("latitude"))
    longitude = _number(state.attributes.get("longitude"))
    if latitude is None or longitude is None:
        return None
    return (latitude, longitude, _number(state.attributes.get("gps_accuracy")))


def icloud_location_observed_at(
    location: Any,
    *,
    now: datetime | None = None,
) -> datetime | None:
    """Return Apple's coordinate timestamp, rejecting cached or invalid fixes."""
    if (
        not isinstance(location, dict)
        or location.get("isOld") is True
        or location.get("locationFinished") is False
        or _number(location.get("latitude")) is None
        or _number(location.get("longitude")) is None
    ):
        return None
    value = location.get("timeStamp")
    if isinstance(value, bool):
        return None
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(timestamp):
        return None
    # Find My reports milliseconds since Unix epoch. Accept seconds as a
    # defensive compatibility fallback without accepting implausible dates.
    if timestamp > 10_000_000_000:
        timestamp /= 1000
    try:
        observed_at = datetime.fromtimestamp(timestamp, timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    current = now or datetime.now(timezone.utc)
    if observed_at.year < 2000 or observed_at > current + timedelta(minutes=5):
        return None
    return observed_at


def update_location_observation(
    observations: LocationObservations,
    state: LocationState,
    *,
    authoritative_observed_at: datetime | None = None,
    authoritative: bool = False,
) -> bool:
    """Record coordinate changes or a provider-confirmed observation time."""
    signature = _location_signature(state)
    if signature is None:
        # An unavailable report must not erase the last valid signature. This
        # prevents a restored cached point from looking like new movement.
        return False
    previous = observations.get(state.entity_id)
    changed = previous is not None and previous.signature != signature
    if authoritative:
        if authoritative_observed_at is not None:
            observed_at = authoritative_observed_at
        elif previous is not None:
            observed_at = previous.observed_at
        else:
            observed_at = datetime(1970, 1, 1, tzinfo=timezone.utc)
    else:
        observed_at = (
            state.last_updated
            if changed
            else previous.observed_at if previous is not None else state.last_changed
        )
    observations[state.entity_id] = LocationObservation(signature, observed_at)
    return changed or (
        previous is not None and previous.observed_at != observed_at
    )


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
        if signature is None:
            continue
        if recovered is None or recovered.signature != signature:
            recovered = LocationObservation(signature, state.last_updated)
    return recovered
