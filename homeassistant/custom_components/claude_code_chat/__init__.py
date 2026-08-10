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

from .const import CONF_ALLOWED_USER_ID, CONF_BRIDGE_TOKEN, CONF_BRIDGE_URL, DOMAIN, REQUEST_TIMEOUT_SECONDS

PLATFORMS = (Platform.CONVERSATION,)


@dataclass
class ClaudeCodeChatData:
    """Runtime data for a Claude Code Chat config entry."""

    bridge_url: str
    bridge_token: str
    allowed_user_id: str


type ClaudeCodeChatConfigEntry = ConfigEntry[ClaudeCodeChatData]


def _entry_data(hass: HomeAssistant) -> ClaudeCodeChatData | None:
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries or not hasattr(entries[0], "runtime_data"):
        return None
    return entries[0].runtime_data


def _authorized(connection: websocket_api.ActiveConnection, data: ClaudeCodeChatData) -> bool:
    return connection.user.id == data.allowed_user_id


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


@websocket_api.websocket_command({vol.Required("type"): "claude_code_chat/process", vol.Required("text"): str})
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
    wrapped_prompt = ("Você está atendendo pelo assistente Codex dentro do Home Assistant. Responda diretamente ao usuário, em português quando o pedido estiver em português. Quando precisar consultar o ambiente, use as ferramentas disponíveis e devolva a resposta final no chat.\n\n" f"Pedido do usuário: {prompt}")
    payload = {"message": wrapped_prompt, "display_message": prompt, "conversation_id": f"home-assistant:codex:{connection.user.id}", "agent": "codex"}
    try:
        async with async_get_clientsession(hass).post(data.bridge_url, json=payload, headers={"Authorization": f"Bearer {data.bridge_token}"}, timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS)) as response:
            response.raise_for_status()
            result = await response.json()
    except Exception as err:  # noqa: BLE001
        connection.send_error(msg["id"], "bridge_error", str(err))
        return
    connection.send_result(msg["id"], {"reply": result.get("reply", "Sem resposta.")})


async def async_setup_entry(
    hass: HomeAssistant, entry: ClaudeCodeChatConfigEntry
) -> bool:
    """Set up Claude Code Chat from a config entry."""
    entry.runtime_data = ClaudeCodeChatData(
        bridge_url=entry.data[CONF_BRIDGE_URL],
        bridge_token=entry.data[CONF_BRIDGE_TOKEN],
        allowed_user_id=entry.data[CONF_ALLOWED_USER_ID],
    )
    if not hass.data.get(f"{DOMAIN}_websocket_registered"):
        websocket_api.async_register_command(hass, websocket_history)
        websocket_api.async_register_command(hass, websocket_process)
        hass.data[f"{DOMAIN}_websocket_registered"] = True
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ClaudeCodeChatConfigEntry
) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
