"""Conversation platform for Claude Code Chat."""

from __future__ import annotations

import logging
from typing import Literal

import aiohttp

from homeassistant.components import conversation
from homeassistant.components.conversation import ConversationEntityFeature
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import ClaudeCodeChatConfigEntry
from .const import DEFAULT_NAME, REQUEST_TIMEOUT_SECONDS
from .context import trusted_context_prompt
from .permissions import is_user_authorized

_LOGGER = logging.getLogger(__name__)


def _persistent_conversation_id(
    agent: str, user_input: conversation.ConversationInput
) -> str:
    """Return a stable bridge conversation id for each HA user and agent.

    The Assist dialog creates a fresh conversation id when it is reopened. Using
    that id in the bridge fragments the persisted transcript and CLI session.
    The authenticated HA user id is stable, so it keeps backend conversations
    continuous without mixing users or agents.
    """
    return f"home-assistant:{agent}:{user_input.context.user_id}"


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
    """Conversation agent that forwards messages to the ai-bridge service.

    Unlike the built-in Anthropic conversation entity, this agent does not use
    Home Assistant's LLM/chat_log machinery: `async_process` is overridden
    directly (it is not marked @final on the ConversationEntity base class),
    so the bridge is fully responsible for the model call and tool execution.
    """

    _attr_has_entity_name = True
    _attr_name = DEFAULT_NAME
    _attr_supported_features = ConversationEntityFeature.CONTROL

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

        if not is_user_authorized(
            user_input.context.user_id, data.allowed_user_ids
        ):
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
        user = await self.hass.auth.async_get_user(user_input.context.user_id)
        payload = {
            "message": trusted_context_prompt(
                user_input.text,
                user.name if user else None,
                "Claude Code",
                is_admin=bool(user and user.is_admin),
            ),
            "display_message": user_input.text,
            "conversation_id": _persistent_conversation_id("claude", user_input),
            "agent": "claude",
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
            _LOGGER.exception("Erro ao chamar ai-bridge")
            reply = "Não consegui falar com o ai-bridge. Verifique se o container está no ar."

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
    _attr_supported_features = ConversationEntityFeature.CONTROL

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

        if not is_user_authorized(
            user_input.context.user_id, data.allowed_user_ids
        ):
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
        user = await self.hass.auth.async_get_user(user_input.context.user_id)
        message = trusted_context_prompt(
            prompt,
            user.name if user else None,
            "Codex",
            is_admin=bool(user and user.is_admin),
        )
        payload = {
            "message": message,
            "display_message": prompt,
            "conversation_id": _persistent_conversation_id("codex", user_input),
            "agent": "codex",
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
