"""Fournisseur Claude (Anthropic), via le SDK officiel `anthropic` >= 1.0.

Points d'implementation importants:

* Streaming systematique (`messages.stream`) - c'est ce qui permet au TTS de
  demarrer avant la fin de la generation.
* Aucun parametre `temperature` / `top_p`: ces parametres sont retires sur les
  modeles Claude recents et provoquent une erreur 400.
* `output_config.effort` n'est envoye qu'aux modeles qui le supportent.
* Aucun parametre `thinking` explicite: les modeles recents raisonnent en mode
  adaptatif par defaut, les plus anciens n'en ont pas besoin ici.
* `stop_reason == "refusal"` est traduit en `LLMRefusalError` - on ne fabrique
  jamais une reponse a la place du modele.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from jarvis_core.errors import ConfigurationError, LLMError, LLMRefusalError
from jarvis_core.llm.base import (
    ContentBlock,
    LLMMessage,
    LLMProvider,
    LLMResponse,
    StreamCallback,
    TextBlock,
    ToolCall,
    ToolResultBlock,
    ToolSpec,
    Usage,
)

logger = logging.getLogger(__name__)

#: Modeles acceptant `output_config.effort`.  Les autres renvoient une 400.
_EFFORT_CAPABLE_PREFIXES = (
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-fable-5",
)


def _supports_effort(model: str) -> bool:
    return any(model.startswith(prefix) for prefix in _EFFORT_CAPABLE_PREFIXES)


class AnthropicProvider(LLMProvider):
    """Implementation de `LLMProvider` pour l'API Claude."""

    name = "anthropic"

    def __init__(self, api_key: str, *, timeout: float = 60.0, max_retries: int = 2) -> None:
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - depend de l'install
            raise ConfigurationError(
                "Le paquet 'anthropic' n'est pas installe. "
                "Installer avec: pip install 'anthropic>=1.0.0'"
            ) from exc
        if not api_key:
            raise ConfigurationError(
                "ANTHROPIC_API_KEY est absente. Remplis-la dans .env, "
                "ou passe JARVIS_LLM_PROVIDER=mock pour travailler hors ligne."
            )
        self._anthropic = anthropic
        self._client = anthropic.AsyncAnthropic(
            api_key=api_key, timeout=timeout, max_retries=max_retries
        )

    async def complete(
        self,
        *,
        model: str,
        system: str,
        messages: list[LLMMessage],
        tools: list[ToolSpec] | None = None,
        max_tokens: int = 2000,
        effort: str | None = None,
        on_text: StreamCallback | None = None,
    ) -> LLMResponse:
        started = time.perf_counter()
        params: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            # Le prompt systeme est stable d'un tour a l'autre: on le met en
            # cache pour reduire cout et latence.
            "system": [
                {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
            ],
            "messages": [_to_api_message(m) for m in messages],
        }
        if tools:
            params["tools"] = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }
                for tool in tools
            ]
        if effort and _supports_effort(model):
            params["output_config"] = {"effort": effort}

        try:
            async with self._client.messages.stream(**params) as stream:
                async for event in stream:
                    if on_text is None or event.type != "content_block_delta":
                        continue
                    delta = event.delta
                    if delta.type == "text_delta":
                        await on_text(delta.text)
                final = await stream.get_final_message()
        except self._anthropic.RateLimitError as exc:
            raise LLMError(
                str(exc),
                user_message="Je suis limite par le fournisseur, reessaie dans un instant.",
            ) from exc
        except self._anthropic.AuthenticationError as exc:
            raise ConfigurationError(
                str(exc), user_message="Ma cle d'API Claude est refusee."
            ) from exc
        except self._anthropic.APIConnectionError as exc:
            raise LLMError(
                str(exc), user_message="Je n'arrive pas a joindre mon moteur de raisonnement."
            ) from exc
        except self._anthropic.APIStatusError as exc:
            logger.error("Erreur API Anthropic %s: %s", exc.status_code, exc)
            raise LLMError(str(exc)) from exc

        if final.stop_reason == "refusal":
            details = getattr(final, "stop_details", None)
            category = getattr(details, "category", None) if details else None
            raise LLMRefusalError(f"refus du modele (categorie={category})")

        return _from_api_message(final, latency_ms=int((time.perf_counter() - started) * 1000))

    async def aclose(self) -> None:
        await self._client.close()


def _to_api_message(message: LLMMessage) -> dict[str, Any]:
    """Convertit un message interne vers le format Messages API."""
    blocks: list[dict[str, Any]] = []
    for block in message.content:
        if isinstance(block, TextBlock):
            if block.text:
                blocks.append({"type": "text", "text": block.text})
        elif isinstance(block, ToolCall):
            blocks.append(
                {
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.arguments,
                }
            )
        elif isinstance(block, ToolResultBlock):
            blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.tool_call_id,
                    "content": block.content,
                    "is_error": block.is_error,
                }
            )
    if not blocks:
        blocks = [{"type": "text", "text": ""}]
    return {"role": message.role, "content": blocks}


def _from_api_message(message: Any, *, latency_ms: int) -> LLMResponse:
    """Convertit une reponse Messages API vers le format interne."""
    texts: list[str] = []
    tool_calls: list[ToolCall] = []
    raw: list[ContentBlock] = []

    for block in message.content:
        if block.type == "text":
            texts.append(block.text)
            raw.append(TextBlock(text=block.text))
        elif block.type == "tool_use":
            # Les entrees d'outil sont deja des objets JSON parses par le SDK.
            arguments = block.input if isinstance(block.input, dict) else json.loads(block.input)
            call = ToolCall(id=block.id, name=block.name, arguments=arguments)
            tool_calls.append(call)
            raw.append(call)

    usage = Usage(
        input_tokens=getattr(message.usage, "input_tokens", 0) or 0,
        output_tokens=getattr(message.usage, "output_tokens", 0) or 0,
        cache_read_tokens=getattr(message.usage, "cache_read_input_tokens", 0) or 0,
        cache_write_tokens=getattr(message.usage, "cache_creation_input_tokens", 0) or 0,
    )
    return LLMResponse(
        text="".join(texts).strip(),
        tool_calls=tool_calls,
        stop_reason=message.stop_reason or "end_turn",
        model=message.model,
        usage=usage,
        latency_ms=latency_ms,
        raw_content=raw,
    )
