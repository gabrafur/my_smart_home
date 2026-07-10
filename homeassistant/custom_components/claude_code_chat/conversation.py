"""Conversation platform for Claude Code Chat."""

from __future__ import annotations

import logging
from typing import Literal

import aiohttp

from homeassistant.components import conversation
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import ClaudeCodeChatConfigEntry
from .const import DEFAULT_NAME, REQUEST_TIMEOUT_SECONDS

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ClaudeCodeChatConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the conversation entities."""
    entities = [
        ClaudeCodeConversationEntity(entry),
        CodexConversationEntity(entry),
    ]
    async_add_entities(entities)


class ClaudeCodeConversationEntity(
    conversation.ConversationEntity, conversation.AbstractConversationAgent
):
    """Conversation agent that forwards messages to the claude-bridge service.

    Unlike the built-in Anthropic conversation entity, this agent does not use
    Home Assistant's LLM/chat_log machinery: `async_process` is overridden
    directly (it is not marked @final on the ConversationEntity base class),
    so the bridge is fully responsible for the model call and tool execution.
    """

    _attr_has_entity_name = True
    _attr_name = DEFAULT_NAME

    def __init__(self, entry: ClaudeCodeChatConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_conversation"

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Return a list of supported languages."""
        return MATCH_ALL

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        """Process a sentence."""
        response = intent.IntentResponse(language=user_input.language)
        data = self._entry.runtime_data

        if user_input.context.user_id != data.allowed_user_id:
            _LOGGER.warning(
                "Claude Code Chat: usuário não autorizado tentou usar o agente (user_id=%s)",
                user_input.context.user_id,
            )
            response.async_set_error(
                intent.IntentResponseErrorCode.NO_INTENT_MATCH,
                "Você não está autorizado a usar este assistente.",
            )
            return conversation.ConversationResult(
                response=response, conversation_id=user_input.conversation_id
            )

        session = async_get_clientsession(self.hass)
        payload = {
            "message": user_input.text,
            "conversation_id": user_input.conversation_id,
        }
        headers = {"Authorization": f"Bearer {data.bridge_token}"}

        try:
            async with session.post(
                data.bridge_url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                result = await resp.json()
                reply = result.get("reply", "Sem resposta da ponte Claude Code.")
        except Exception:  # noqa: BLE001 - surface any bridge failure as a chat reply
            _LOGGER.exception("Erro ao chamar claude-bridge")
            reply = "Não consegui falar com o claude-bridge. Verifique se o container está no ar."

        response.async_set_speech(reply)
        return conversation.ConversationResult(
            response=response, conversation_id=user_input.conversation_id
        )


class CodexConversationEntity(
    conversation.ConversationEntity, conversation.AbstractConversationAgent
):
    """Conversation agent that forwards Codex requests to the execution bridge."""

    _attr_has_entity_name = True
    _attr_name = "Codex"

    def __init__(self, entry: ClaudeCodeChatConfigEntry) -> None:
        self._entry = entry
        self._attr_unique_id = f"{entry.entry_id}_codex_conversation"

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Return a list of supported languages."""
        return MATCH_ALL

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        """Process a sentence by returning a live bridge response."""
        response = intent.IntentResponse(language=user_input.language)
        data = self._entry.runtime_data

        if user_input.context.user_id != data.allowed_user_id:
            _LOGGER.warning(
                "Codex: usuário não autorizado tentou usar o agente (user_id=%s)",
                user_input.context.user_id,
            )
            response.async_set_error(
                intent.IntentResponseErrorCode.NO_INTENT_MATCH,
                "Você não está autorizado a usar este assistente.",
            )
            return conversation.ConversationResult(
                response=response, conversation_id=user_input.conversation_id
            )

        prompt = user_input.text.strip()
        if not prompt:
            response.async_set_error(
                intent.IntentResponseErrorCode.NO_INTENT_MATCH,
                "Diga o que você quer enviar para o Codex.",
            )
            return conversation.ConversationResult(
                response=response, conversation_id=user_input.conversation_id
            )

        session = async_get_clientsession(self.hass)
        conversation_id = (
            f"codex:{user_input.conversation_id}"
            if user_input.conversation_id
            else None
        )
        message = (
            "Você está atendendo pelo assistente Codex dentro do Home Assistant. "
            "Responda diretamente ao usuário, em português quando o pedido estiver "
            "em português. Quando precisar consultar o ambiente, use as ferramentas "
            "disponíveis e devolva a resposta final no chat.\n\n"
            f"Pedido do usuário: {prompt}"
        )
        payload = {
            "message": message,
            "conversation_id": conversation_id,
        }
        headers = {"Authorization": f"Bearer {data.bridge_token}"}

        try:
            async with session.post(
                data.bridge_url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS),
            ) as resp:
                resp.raise_for_status()
                result = await resp.json()
                reply = result.get("reply", "Sem resposta da ponte de execução.")
        except Exception:  # noqa: BLE001 - surface any bridge failure as a chat reply
            _LOGGER.exception("Erro ao chamar a ponte de execução do Codex")
            reply = "Não consegui falar com a ponte de execução. Verifique se o container está no ar."

        response.async_set_speech(reply)
        return conversation.ConversationResult(
            response=response, conversation_id=user_input.conversation_id
        )
