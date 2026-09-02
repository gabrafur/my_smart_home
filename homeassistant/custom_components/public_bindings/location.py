"""Location-source selection shared by public binding projections."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from math import inf, isfinite
from typing import Any, NamedTuple, Protocol, Sequence

LOCATION_FRESHNESS = timedelta(minutes=15)
FUTURE_TOLERANCE = timedelta(minutes=1)
RECENCY_TIE = timedelta(minutes=1)
MAX_GPS_ACCURACY_METERS = 100
INVALID_STATES = {"", "unknown", "unavailable"}
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


def _has_reliable_coordinates(state: LocationState) -> bool:
    latitude = _number(state.attributes.get("latitude"))
    longitude = _number(state.attributes.get("longitude"))
    accuracy = _number(state.attributes.get("gps_accuracy"))
    return (
        latitude is not None
        and longitude is not None
        and (accuracy is None or accuracy <= MAX_GPS_ACCURACY_METERS)
    )


def _is_fresh_at(observed_at: datetime, now: datetime) -> bool:
    return (
        observed_at <= now + FUTURE_TOLERANCE
        and now - observed_at <= LOCATION_FRESHNESS
    )


def _accuracy(state: LocationState) -> float:
    accuracy = _number(state.attributes.get("gps_accuracy"))
    return accuracy if accuracy is not None and accuracy >= 0 else inf


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


def _observed_at(
    state: LocationState,
    observations: LocationObservations | None,
) -> datetime:
    return (
        location_observed_at(observations, state)
        if observations is not None
        else state.last_updated
    )


def select_best_location(
    states: Sequence[LocationState],
    now: datetime | None = None,
    observations: LocationObservations | None = None,
) -> LocationState | None:
    """Select the best source using the same priorities as Node-RED."""
    if not states:
        return None

    current = now or datetime.now(timezone.utc)
    selected = states[0]

    for candidate in states[1:]:
        selected_observed_at = _observed_at(selected, observations)
        candidate_observed_at = _observed_at(candidate, observations)
        selected_fresh = _is_fresh_at(selected_observed_at, current)
        candidate_fresh = _is_fresh_at(candidate_observed_at, current)
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

        recency_delta = candidate_observed_at - selected_observed_at
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

        if candidate_observed_at != selected_observed_at:
            if candidate_observed_at > selected_observed_at:
                selected = candidate
            continue

        selected_valid = selected.state not in INVALID_STATES
        candidate_valid = candidate.state not in INVALID_STATES
        if selected_valid != candidate_valid and candidate_valid:
            selected = candidate

    return selected
