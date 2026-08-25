"""The Claude Code Chat integration."""

from __future__ import annotations

from dataclasses import dataclass

import aiohttp
import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_ALLOWED_USER_ID,
    CONF_ALLOWED_USER_IDS,
    CONF_BRIDGE_TOKEN,
    CONF_BRIDGE_URL,
    DOMAIN,
    REQUEST_TIMEOUT_SECONDS,
)
from .context import trusted_context_prompt
from .permissions import is_user_authorized, normalize_allowed_user_ids

PLATFORMS = (Platform.CONVERSATION,)
CODEX_MODELS = {
    "gpt-5.6-luna": {"low", "medium", "high", "xhigh", "max"},
    "gpt-5.6-terra": {"low", "medium", "high", "xhigh", "max", "ultra"},
    "gpt-5.6-sol": {"low", "medium", "high", "xhigh", "max", "ultra"},
}
CODEX_REASONING_EFFORTS = set().union(*CODEX_MODELS.values())
DEFAULT_CODEX_MODEL = "gpt-5.6-luna"
DEFAULT_CODEX_REASONING_EFFORT = "low"


@dataclass
class ClaudeCodeChatData:
    """Runtime data for a Claude Code Chat config entry."""

    bridge_url: str
    bridge_token: str
    allowed_user_ids: frozenset[str]


type ClaudeCodeChatConfigEntry = ConfigEntry[ClaudeCodeChatData]


def _entry_data(hass: HomeAssistant) -> ClaudeCodeChatData | None:
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries or not hasattr(entries[0], "runtime_data"):
        return None
    return entries[0].runtime_data


def _authorized(
    connection: websocket_api.ActiveConnection, data: ClaudeCodeChatData
) -> bool:
    return is_user_authorized(connection.user.id, data.allowed_user_ids)


@websocket_api.websocket_command({vol.Required("type"): "claude_code_chat/history", vol.Optional("limit", default=100): int})
@websocket_api.async_response
async def websocket_history(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Return the persistent Codex transcript without exposing its token."""
    data = _entry_data(hass)
    if data is None:
        connection.send_error(msg["id"], "not_loaded", "Integração não carregada")
        return
    if not _authorized(connection, data):
        connection.send_error(msg["id"], "unauthorized", "Usuário não autorizado")
        return
    history_url = data.bridge_url.rsplit("/chat", 1)[0] + "/history"
    params = {"agent": "codex", "conversation_id": f"home-assistant:codex:{connection.user.id}", "limit": str(min(max(msg["limit"], 1), 500))}
    try:
        async with async_get_clientsession(hass).get(history_url, params=params, headers={"Authorization": f"Bearer {data.bridge_token}"}, timeout=aiohttp.ClientTimeout(total=30)) as response:
            response.raise_for_status()
            payload = await response.json()
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "bridge_error", str(err))
        return
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command({vol.Required("type"): "claude_code_chat/clear"})
@websocket_api.async_response
async def websocket_clear(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Clear the authenticated user's Codex transcript and session context."""
    data = _entry_data(hass)
    if data is None:
        connection.send_error(msg["id"], "not_loaded", "Integração não carregada")
        return
    if not _authorized(connection, data):
        connection.send_error(msg["id"], "unauthorized", "Usuário não autorizado")
        return
    history_url = data.bridge_url.rsplit("/chat", 1)[0] + "/history"
    params = {"agent": "codex", "conversation_id": f"home-assistant:codex:{connection.user.id}"}
    try:
        async with async_get_clientsession(hass).delete(history_url, params=params, headers={"Authorization": f"Bearer {data.bridge_token}"}, timeout=aiohttp.ClientTimeout(total=30)) as response:
            response.raise_for_status()
            payload = await response.json()
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "bridge_error", str(err))
        return
    connection.send_result(msg["id"], payload)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "claude_code_chat/process",
        vol.Required("text"): str,
        vol.Optional("model", default=DEFAULT_CODEX_MODEL): str,
        vol.Optional("reasoning_effort", default=DEFAULT_CODEX_REASONING_EFFORT): str,
    }
)
@websocket_api.async_response
async def websocket_process(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Send a message to Codex and persist it in the shared transcript."""
    data = _entry_data(hass)
    if data is None:
        connection.send_error(msg["id"], "not_loaded", "Integração não carregada")
        return
    if not _authorized(connection, data):
        connection.send_error(msg["id"], "unauthorized", "Usuário não autorizado")
        return
    prompt = msg["text"].strip()
    if not prompt:
        connection.send_error(msg["id"], "empty_message", "Mensagem vazia")
        return
    model = msg.get("model")
    reasoning_effort = msg.get("reasoning_effort")
    if model not in CODEX_MODELS:
        connection.send_error(msg["id"], "invalid_model", "Modelo Codex não suportado")
        return
    allowed_efforts = CODEX_MODELS.get(model, CODEX_REASONING_EFFORTS)
    if reasoning_effort not in allowed_efforts:
        connection.send_error(msg["id"], "invalid_reasoning", "Reasoning não suportado para o modelo escolhido")
        return
    wrapped_prompt = trusted_context_prompt(
        prompt,
        connection.user.name,
        "Codex",
        is_admin=connection.user.is_admin,
    )
    payload = {
        "message": wrapped_prompt,
        "display_message": prompt,
        "conversation_id": f"home-assistant:codex:{connection.user.id}",
        "agent": "codex",
    }
    payload["model"] = model
    payload["reasoning_effort"] = reasoning_effort
    try:
        async with async_get_clientsession(hass).post(data.bridge_url, json=payload, headers={"Authorization": f"Bearer {data.bridge_token}"}, timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS)) as response:
            response.raise_for_status()
            result = await response.json()
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "bridge_error", str(err))
        return
    connection.send_result(
        msg["id"],
        {
            "reply": result.get("reply", "Sem resposta."),
            "model": result.get("model"),
            "reasoning_effort": result.get("reasoning_effort"),
        },
    )


async def async_setup_entry(
    hass: HomeAssistant, entry: ClaudeCodeChatConfigEntry
) -> bool:
    """Set up Claude Code Chat from a config entry."""
    allowed_user_ids = normalize_allowed_user_ids(
        entry.options.get(CONF_ALLOWED_USER_IDS, entry.data.get(CONF_ALLOWED_USER_IDS)),
        entry.data.get(CONF_ALLOWED_USER_ID),
    )
    entry.runtime_data = ClaudeCodeChatData(
        bridge_url=entry.data[CONF_BRIDGE_URL],
        bridge_token=entry.data[CONF_BRIDGE_TOKEN],
        allowed_user_ids=allowed_user_ids,
    )
    if not hass.data.get(f"{DOMAIN}_websocket_registered"):
        websocket_api.async_register_command(hass, websocket_history)
        websocket_api.async_register_command(hass, websocket_clear)
        websocket_api.async_register_command(hass, websocket_process)
        hass.data[f"{DOMAIN}_websocket_registered"] = True
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_migrate_entry(
    hass: HomeAssistant, entry: ClaudeCodeChatConfigEntry
) -> bool:
    """Migrate the single-user permission to an explicit allowlist."""
    if entry.version != 1:
        return True

    data = dict(entry.data)
    allowed_user_ids = normalize_allowed_user_ids(
        data.get(CONF_ALLOWED_USER_IDS), data.pop(CONF_ALLOWED_USER_ID, None)
    )
    if not allowed_user_ids:
        return False

    data[CONF_ALLOWED_USER_IDS] = sorted(allowed_user_ids)
    hass.config_entries.async_update_entry(entry, data=data, version=2)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ClaudeCodeChatConfigEntry
) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
