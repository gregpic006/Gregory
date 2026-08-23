"""Evenements emis pendant un tour de conversation.

Ils alimentent l'interface en temps reel ("Recherche dans Gmail...", "3 messages
trouves").  Regle d'interface: on expose les ACTIONS et les RESULTATS, jamais le
raisonnement interne du modele.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class EventType(StrEnum):
    """Types d'evenements du pipeline."""

    STATE = "state"
    """Changement d'etat: listening, understanding, working, speaking, idle."""

    TRANSCRIPT = "transcript"
    """Transcription de la parole, partielle ou finale."""

    TOKEN = "token"
    """Fragment de texte genere (streaming)."""

    TOOL_START = "tool_start"
    TOOL_END = "tool_end"
    CONFIRMATION_REQUIRED = "confirmation_required"
    MESSAGE = "message"
    """Reponse finale complete."""

    CITATIONS = "citations"
    AUDIO = "audio"
    """Audio TTS encode en base64."""

    ERROR = "error"
    METRICS = "metrics"


class State(StrEnum):
    """Etats affiches dans l'interface."""

    IDLE = "idle"
    LISTENING = "listening"
    TRANSCRIBING = "transcribing"
    UNDERSTANDING = "understanding"
    WORKING = "working"
    SPEAKING = "speaking"


@dataclass
class JarvisEvent:
    """Un evenement serialisable vers le client."""

    type: EventType
    payload: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"type": self.type.value, **self.payload}

    # -- constructeurs pratiques --------------------------------------------

    @classmethod
    def state(cls, state: State, detail: str = "") -> JarvisEvent:
        return cls(EventType.STATE, {"state": state.value, "detail": detail})

    @classmethod
    def transcript(cls, text: str, *, final: bool = True) -> JarvisEvent:
        return cls(EventType.TRANSCRIPT, {"text": text, "final": final})

    @classmethod
    def token(cls, text: str) -> JarvisEvent:
        return cls(EventType.TOKEN, {"text": text})

    @classmethod
    def tool_start(cls, name: str, label: str) -> JarvisEvent:
        return cls(EventType.TOOL_START, {"tool": name, "label": label})

    @classmethod
    def tool_end(
        cls, name: str, *, ok: bool, summary: str, data: dict[str, Any] | None = None
    ) -> JarvisEvent:
        return cls(
            EventType.TOOL_END,
            {"tool": name, "ok": ok, "summary": summary, "data": data or {}},
        )

    @classmethod
    def confirmation(cls, action: dict[str, Any], question: str) -> JarvisEvent:
        return cls(EventType.CONFIRMATION_REQUIRED, {"action": action, "question": question})

    @classmethod
    def message(cls, text: str, **extra: Any) -> JarvisEvent:
        return cls(EventType.MESSAGE, {"text": text, **extra})

    @classmethod
    def citations(cls, items: list[dict[str, Any]]) -> JarvisEvent:
        return cls(EventType.CITATIONS, {"citations": items})

    @classmethod
    def audio(cls, b64: str, mime: str) -> JarvisEvent:
        return cls(EventType.AUDIO, {"audio_base64": b64, "mime": mime})

    @classmethod
    def error(cls, message: str, *, code: str = "error") -> JarvisEvent:
        return cls(EventType.ERROR, {"message": message, "code": code})

    @classmethod
    def metrics(cls, data: dict[str, Any]) -> JarvisEvent:
        return cls(EventType.METRICS, data)


#: Signature d'un consommateur d'evenements (WebSocket, tests, journal).
EventSink = Callable[[JarvisEvent], Awaitable[None]]


async def noop_sink(event: JarvisEvent) -> None:  # noqa: ARG001
    """Consommateur nul, utilise en mode texte simple."""
    return None
