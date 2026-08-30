"""Synchronize the native Map dashboard with a canonical YAML dashboard."""

from __future__ import annotations

import asyncio
from copy import deepcopy
import logging
from pathlib import Path
from typing import Any, Iterator

import voluptuous as vol

from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.const import ATTR_LATITUDE, ATTR_LONGITUDE, EVENT_STATE_CHANGED
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.util.yaml import Secrets, load_yaml_dict

DOMAIN = "consolidated_map"
DEFAULT_PATH = "dashboards/location.yaml"
NATIVE_MAP_PATH = "map"

CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {vol.Optional("path", default=DEFAULT_PATH): cv.string},
            extra=vol.PREVENT_EXTRA,
        )
    },
    extra=vol.ALLOW_EXTRA,
)

_LOGGER = logging.getLogger(__name__)


def _walk_cards(value: Any) -> Iterator[dict[str, Any]]:
    """Yield cards from masonry, grid, stack, and sections layouts."""
    if isinstance(value, dict):
        if isinstance(value.get("type"), str):
            yield value
        for child in value.values():
            yield from _walk_cards(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_cards(child)


def _map_card(dashboard: dict[str, Any]) -> dict[str, Any] | None:
    """Return the dashboard's map card."""
    return next(
        (card for card in _walk_cards(dashboard) if card.get("type") == "map"),
        None,
    )


def _load_dashboard(config_dir: Path, relative_path: str) -> dict[str, Any]:
    """Load the shared dashboard and resolve its private labels."""
    dashboard = load_yaml_dict(config_dir / relative_path, Secrets(config_dir))
    views = dashboard.get("views")
    if not isinstance(views, list) or len(views) != 1:
        raise ValueError("consolidated map must contain exactly one view")

    map_card = _map_card(dashboard)
    if not map_card or map_card.get("show_all") is not True or "entities" in map_card:
        raise ValueError("consolidated map must automatically include map entities")

    markdown = "\n".join(
        str(card.get("content", ""))
        for card in _walk_cards(dashboard)
        if card.get("type") == "markdown"
    )
    if "selected_location_source" not in markdown or "location_sources" not in markdown:
        raise ValueError("consolidated map must expose source selection and freshness")

    return dashboard


def _has_coordinates(state: Any) -> bool:
    """Return whether a state exposes usable map coordinates."""
    latitude = state.attributes.get(ATTR_LATITUDE)
    longitude = state.attributes.get(ATTR_LONGITUDE)
    return (
        isinstance(latitude, (int, float))
        and not isinstance(latitude, bool)
        and isinstance(longitude, (int, float))
        and not isinstance(longitude, bool)
    )


def _location_entity_ids(hass: HomeAssistant) -> tuple[str, ...]:
    """Discover visible locations while omitting zones and person sources."""
    registry = er.async_get(hass)
    person_sources = {
        state.attributes["source"]
        for state in hass.states.async_all("person")
        if isinstance(state.attributes.get("source"), str)
    }
    entities = []
    for state in hass.states.async_all():
        entity_id = state.entity_id
        if entity_id.startswith("zone.") or entity_id in person_sources:
            continue
        if not _has_coordinates(state):
            continue
        entry = registry.async_get(entity_id)
        if entry is not None and entry.hidden_by is not None:
            continue
        entities.append(entity_id)
    return tuple(sorted(entities))


def _materialize_dashboard(
    canonical: dict[str, Any], entity_ids: tuple[str, ...]
) -> dict[str, Any]:
    """Replace show-all with the current dynamic, zone-free entity set."""
    dashboard = deepcopy(canonical)
    map_card = _map_card(dashboard)
    if map_card is None:
        raise ValueError("consolidated map has no map card")
    map_card.pop("show_all", None)
    map_card["entities"] = list(entity_ids)
    return dashboard


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Replace the native automatic map strategy with the shared dashboard."""
    relative_path = config.get(DOMAIN, {}).get("path", DEFAULT_PATH)
    config_dir = Path(hass.config.config_dir)
    try:
        dashboard = await hass.async_add_executor_job(
            _load_dashboard, config_dir, relative_path
        )
    except (OSError, ValueError, vol.Invalid):
        _LOGGER.exception("Unable to load the consolidated map dashboard")
        return False

    native_map = hass.data[LOVELACE_DATA].dashboards.get(NATIVE_MAP_PATH)
    if native_map is None:
        _LOGGER.error("Native Map dashboard is unavailable")
        return False

    lock = asyncio.Lock()
    data = hass.data[DOMAIN] = {
        "path": relative_path,
        "canonical": dashboard,
        "entity_ids": (),
        "lock": lock,
    }

    async def async_sync_dashboard(*, force: bool = False) -> None:
        """Update the native dashboard when the visible entity set changes."""
        async with lock:
            entity_ids = _location_entity_ids(hass)
            if not force and entity_ids == data["entity_ids"]:
                return
            rendered = _materialize_dashboard(dashboard, entity_ids)
            current = await native_map.async_load(False)
            if current != rendered:
                await native_map.async_save(rendered)
            data["entity_ids"] = entity_ids

    try:
        await async_sync_dashboard(force=True)
    except HomeAssistantError:
        _LOGGER.exception("Unable to update the native Map dashboard")
        return False

    @callback
    def schedule_sync(event: Event) -> None:
        """Rescan after relevant state or entity-registry changes."""
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        entity_id = event.data.get("entity_id", "")
        domain = entity_id.partition(".")[0]
        if event.event_type == EVENT_STATE_CHANGED and not (
            domain in {"device_tracker", "geo_location", "person", "zone"}
            or (old_state is not None and _has_coordinates(old_state))
            or (new_state is not None and _has_coordinates(new_state))
        ):
            return
        hass.async_create_task(async_sync_dashboard())

    hass.bus.async_listen(EVENT_STATE_CHANGED, schedule_sync)
    hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, schedule_sync)
    return True
