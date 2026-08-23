"""Fournisseur LLM local, deterministe, sans reseau.

Il a deux usages precis:

* les tests (comportement reproductible, aucun cout, aucune latence reseau);
* le mode hors ligne / sans cle API, pour valider tout le pipeline vocal et
  l'interface avant de brancher un vrai modele.

Il ne pretend pas raisonner.  Il reconnait quelques intentions par mots-cles,
appelle les outils correspondants, et annonce clairement qu'il tourne en mode
degrade quand il ne comprend pas.
"""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

from jarvis_core.llm.base import (
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

_GREETINGS = (
    "bon matin", "bonjour", "bonsoir", "bonne nuit", "salut", "allo",
    "good morning", "good evening", "hello", "hey",
)


def _strip_accents(text: str) -> str:
    table = str.maketrans("àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ", "aaaeeeeiioouuucAAAEEEEIIOOUUUC")
    return text.translate(table)


class MockLLMProvider(LLMProvider):
    """Moteur de secours a base de regles."""

    name = "mock"

    def __init__(self, *, jarvis_name: str = "Jarvis", user_name: str = "") -> None:
        self.jarvis_name = jarvis_name
        self.user_name = user_name

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
        tool_names = {t.name for t in (tools or [])}

        last_user = self._last_user_text(messages)
        pending_results = self._last_tool_results(messages)

        if pending_results is not None:
            text = self._summarize_tool_results(pending_results)
            return await self._finish(text, [], model, started, on_text)

        normalized = _strip_accents(last_user.lower()).strip()

        # 1) Salutation -> reponse de personnalite, aucun outil.
        if self._is_greeting(normalized):
            return await self._finish(self._greeting_reply(normalized), [], model, started, on_text)

        # 2) Heure / date -> outil temporel.
        if "get_current_time" in tool_names and re.search(
            r"\b(heure|date|quel jour|on est quel|time|today)\b", normalized
        ):
            call = ToolCall(id=_new_id(), name="get_current_time", arguments={})
            return await self._finish("", [call], model, started, on_text, stop="tool_use")

        # 3) Rappels.
        if "create_reminder" in tool_names and re.search(
            r"\brappelle[- ]?moi|rappel\b|reminds? me\b", normalized
        ):
            when = self._extract_when(normalized)
            what = self._extract_reminder_subject(last_user)
            call = ToolCall(
                id=_new_id(),
                name="create_reminder",
                arguments={"text": what, "when": when},
            )
            return await self._finish("", [call], model, started, on_text, stop="tool_use")

        if "list_reminders" in tool_names and re.search(r"\bmes rappels|rappels\b", normalized):
            call = ToolCall(id=_new_id(), name="list_reminders", arguments={})
            return await self._finish("", [call], model, started, on_text, stop="tool_use")

        # 4) Calcul.
        if "calculate" in tool_names:
            expr = re.search(r"[-+]?\d[\d\s.,]*\s*[-+*/x%]\s*[-+]?\d[\d\s.,]*", last_user)
            if expr:
                call = ToolCall(
                    id=_new_id(),
                    name="calculate",
                    arguments={"expression": expr.group(0).replace("x", "*")},
                )
                return await self._finish("", [call], model, started, on_text, stop="tool_use")

        # 5) Memoire de session.
        if "remember_fact" in tool_names and re.search(
            r"\b(retiens|souviens[- ]toi|note que|remember that)\b", normalized
        ):
            call = ToolCall(
                id=_new_id(),
                name="remember_fact",
                arguments={"fact": last_user, "source": "utilisateur"},
            )
            return await self._finish("", [call], model, started, on_text, stop="tool_use")

        # 6) Aveu d'incapacite - jamais d'invention.
        text = (
            "Je tourne en mode local, sans modele de langage. Je gere l'heure, les "
            "calculs, les rappels et la memoire de session. Pour le reste, il me faut "
            "une cle ANTHROPIC_API_KEY dans le fichier .env."
        )
        return await self._finish(text, [], model, started, on_text)

    # -- helpers -------------------------------------------------------------

    @staticmethod
    def _last_user_text(messages: list[LLMMessage]) -> str:
        for message in reversed(messages):
            if message.role == "user" and message.text.strip():
                return message.text.strip()
        return ""

    @staticmethod
    def _last_tool_results(messages: list[LLMMessage]) -> list[ToolResultBlock] | None:
        if not messages:
            return None
        last = messages[-1]
        results = [b for b in last.content if isinstance(b, ToolResultBlock)]
        return results or None

    @staticmethod
    def _summarize_tool_results(results: list[ToolResultBlock]) -> str:
        parts = []
        for result in results:
            if result.is_error:
                parts.append(f"Ca n'a pas fonctionne: {result.content}")
            else:
                parts.append(result.content)
        return "\n".join(parts)

    @staticmethod
    def _is_greeting(normalized: str) -> bool:
        return any(normalized.startswith(g) or f" {g}" in normalized for g in _GREETINGS)

    def _greeting_reply(self, normalized: str) -> str:
        who = f" {self.user_name}" if self.user_name else ""
        if "bon matin" in normalized or "good morning" in normalized or "bonjour" in normalized:
            return f"Bon matin{who}. Je suis en ligne. Qu'est-ce qu'on attaque?"
        if "bonsoir" in normalized or "good evening" in normalized:
            return f"Bonsoir{who}. Tout est en place. Qu'est-ce qu'il te faut?"
        if "bonne nuit" in normalized:
            return "Bonne nuit. Je reste en veille."
        return f"Je t'ecoute{who}."

    @staticmethod
    def _extract_when(normalized: str) -> str:
        for expression in (
            "apres-demain", "demain matin", "demain soir", "demain",
            "ce soir", "ce matin", "cet apres-midi", "lundi", "mardi",
            "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
        ):
            if expression in normalized:
                return expression
        match = re.search(r"dans \d+ (?:minutes?|heures?|jours?)", normalized)
        return match.group(0) if match else "demain"

    @staticmethod
    def _extract_reminder_subject(text: str) -> str:
        match = re.search(r"rappelle[- ]?moi\s+(?:de\s+|d'|que\s+)?(.+)", text, re.IGNORECASE)
        subject = match.group(1) if match else text
        subject = re.sub(
            r"\b(demain matin|demain soir|apres-demain|demain|ce soir|ce matin"
            r"|cet apres-midi|dans \d+ \w+)\b",
            "",
            subject,
            flags=re.IGNORECASE,
        )
        return subject.strip(" ,.;") or text

    async def _finish(
        self,
        text: str,
        tool_calls: list[ToolCall],
        model: str,
        started: float,
        on_text: StreamCallback | None,
        stop: str = "end_turn",
    ) -> LLMResponse:
        if text and on_text is not None:
            for chunk in _chunks(text):
                await on_text(chunk)
        content: list[Any] = []
        if text:
            content.append(TextBlock(text=text))
        content.extend(tool_calls)
        return LLMResponse(
            text=text,
            tool_calls=tool_calls,
            stop_reason=stop,
            # On ne pretend pas avoir appele le modele configure.
            model="mock",
            usage=Usage(),
            latency_ms=int((time.perf_counter() - started) * 1000),
            raw_content=content,
        )


def _chunks(text: str, size: int = 24) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)]


def _new_id() -> str:
    return f"mock_{uuid.uuid4().hex[:12]}"
