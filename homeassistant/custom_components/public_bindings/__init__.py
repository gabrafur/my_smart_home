"""Fail-closed logical-role adapter for public Home Assistant configuration."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, EVENT_STATE_CHANGED
from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv

from .location import select_best_location

DOMAIN = "public_bindings"
DEFAULT_PATH = "/run/private-bindings/private-bindings.json"
CONFIG_SCHEMA = vol.Schema(
    {
        DOMAIN: vol.Schema(
            {vol.Optional("path", default=DEFAULT_PATH): cv.string},
            extra=vol.PREVENT_EXTRA,
        )
    },
    extra=vol.ALLOW_EXTRA,
)
SERVICE_CALL = "call"
SERVICE_SCHEMA = vol.Schema(
    {
        vol.Required("role"): cv.string,
        vol.Required("action"): cv.string,
        vol.Optional("data", default={}): dict,
    }
)
STARTUP_SERVICE_WAIT_SECONDS = 30


def _load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"schema_version": 1, "roles": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"schema_version": 1, "roles": {}}
    if value.get("schema_version") != 1 or not isinstance(value.get("roles"), dict):
        return {"schema_version": 1, "roles": {}}
    return value


def _state_value(mode: str, state: str) -> str:
    if mode == "home_away":
        return "home" if state == "home" else "not_home"
    if mode == "boolean":
        return "on" if state == "on" else "off"
    return state


def _binding_targets(binding: dict[str, Any]) -> tuple[str, ...]:
    target = binding.get("target_entity_id")
    if isinstance(target, str):
        return (target,)
    targets = binding.get("target_entity_ids")
    if (
        binding.get("selection_mode") == "best_location"
        and isinstance(targets, list)
        and len(targets) >= 2
        and all(isinstance(item, str) for item in targets)
    ):
        return tuple(targets)
    return ()


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    settings = config.get(DOMAIN, {})
    document = await hass.async_add_executor_job(
        _load,
        Path(settings.get("path", DEFAULT_PATH)),
    )
    entities: dict[str, tuple[str, dict[str, Any]]] = {}
    services: dict[tuple[str, str], dict[str, Any]] = {}

    for role, role_binding in document["roles"].items():
        if not isinstance(role_binding, dict) or role_binding.get("enabled", True) is False:
            continue
        for public_id, binding in role_binding.get("entities", {}).items():
            if isinstance(binding, dict) and _binding_targets(binding):
                entities[public_id] = (role, binding)
        for action, binding in role_binding.get("services", {}).items():
            if isinstance(binding, dict) and isinstance(binding.get("target_service"), str):
                services[(role, action)] = binding

    @callback
    def sync_entity(
        public_id: str,
        role: str,
        binding: dict[str, Any],
        changed_target_id: str | None = None,
    ) -> None:
        targets = _binding_targets(binding)
        sources = [source for target in targets if (source := hass.states.get(target))]
        source = (
            select_best_location(sources)
            if binding.get("selection_mode") == "best_location"
            else (sources[0] if sources else None)
        )
        if source is None:
            hass.states.async_remove(public_id)
            return
        allowed = binding.get("attributes", [])
        attributes = {key: source.attributes[key] for key in allowed if key in source.attributes}
        attributes["binding_role"] = role
        hass.states.async_set(
            public_id,
            _state_value(binding.get("state_mode", "passthrough"), source.state),
            attributes,
            force_update=(
                binding.get("force_update", False)
                and source.entity_id == changed_target_id
            ),
        )

    target_to_public: dict[str, list[str]] = {}
    for public_id, (role, binding) in entities.items():
        for target in _binding_targets(binding):
            target_to_public.setdefault(target, []).append(public_id)
        sync_entity(public_id, role, binding)

    @callback
    def state_changed(event: Any) -> None:
        changed_target_id = event.data.get("entity_id")
        for public_id in target_to_public.get(changed_target_id, []):
            role, binding = entities[public_id]
            sync_entity(public_id, role, binding, changed_target_id)

    hass.bus.async_listen(EVENT_STATE_CHANGED, state_changed)

    async def wait_until_started() -> None:
        if hass.is_running:
            return
        started = asyncio.Event()
        listener_fired = False

        @callback
        def mark_started(_event: Any) -> None:
            nonlocal listener_fired
            listener_fired = True
            started.set()

        remove_listener = hass.bus.async_listen_once(
            EVENT_HOMEASSISTANT_STARTED,
            mark_started,
        )
        if hass.is_running:
            started.set()
        try:
            await asyncio.wait_for(started.wait(), timeout=STARTUP_SERVICE_WAIT_SECONDS)
        except TimeoutError:
            pass
        finally:
            # A one-shot listener removes itself before invoking the callback.
            # Calling its remover again makes Home Assistant log an unknown-job
            # error when several binding calls wait during startup.
            if not listener_fired:
                remove_listener()

    async def call_binding(call: ServiceCall) -> None:
        binding = services.get((call.data["role"], call.data["action"]))
        if binding is None:
            raise HomeAssistantError("Public binding action is unavailable")
        await wait_until_started()
        domain, service = binding["target_service"].split(".", 1)
        data = dict(binding.get("data", {}))
        data.update(call.data.get("data", {}))
        target_public_id = binding.get("target_public_entity_id")
        if target_public_id:
            entity_binding = entities.get(target_public_id)
            if entity_binding is None or entity_binding[0] != call.data["role"]:
                raise HomeAssistantError("Public binding target is unavailable")
            targets = _binding_targets(entity_binding[1])
            if len(targets) != 1:
                raise HomeAssistantError("Public binding target is not actionable")
            data["entity_id"] = targets[0]
        elif binding.get("target_entity_id"):
            data["entity_id"] = binding["target_entity_id"]
        await hass.services.async_call(domain, service, data, blocking=True)

    hass.services.async_register(DOMAIN, SERVICE_CALL, call_binding, schema=SERVICE_SCHEMA)
    hass.data[DOMAIN] = {"entities": tuple(entities), "service_count": len(services)}
    return True
