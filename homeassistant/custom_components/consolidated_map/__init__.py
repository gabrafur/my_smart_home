"""Synchronize the native Map dashboard with a canonical YAML dashboard."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv
from homeassistant.util.yaml import Secrets, load_yaml_dict

DOMAIN = "consolidated_map"
DEFAULT_PATH = "dashboards/location.yaml"
NATIVE_MAP_PATH = "map"
EXPECTED_ENTITIES = (
    "device_tracker.resident_primary_location",
    "device_tracker.resident_secondary_location",
    "device_tracker.vehicle_primary",
)

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


def _load_dashboard(config_dir: Path, relative_path: str) -> dict[str, Any]:
    """Load the shared dashboard and resolve its private labels."""
    dashboard = load_yaml_dict(config_dir / relative_path, Secrets(config_dir))
    views = dashboard.get("views")
    if not isinstance(views, list) or len(views) != 1:
        raise ValueError("consolidated map must contain exactly one view")

    cards = views[0].get("cards") if isinstance(views[0], dict) else None
    if not isinstance(cards, list) or len(cards) < 2:
        raise ValueError("consolidated map must contain a map and entity list")

    for card_type in ("map", "entities"):
        card = next(
            (
                candidate
                for candidate in cards
                if isinstance(candidate, dict) and candidate.get("type") == card_type
            ),
            None,
        )
        entities = card.get("entities") if card else None
        entity_ids = tuple(
            item.get("entity") for item in entities or () if isinstance(item, dict)
        )
        if entity_ids != EXPECTED_ENTITIES:
            raise ValueError(
                f"consolidated {card_type} card must use the three canonical entities"
            )

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

    try:
        current = await native_map.async_load(False)
        if current != dashboard:
            await native_map.async_save(dashboard)
    except HomeAssistantError:
        _LOGGER.exception("Unable to update the native Map dashboard")
        return False

    hass.data[DOMAIN] = {
        "entities": EXPECTED_ENTITIES,
        "path": relative_path,
    }
    return True
