"""Memoire de conversation (court terme).

Elle sert a rendre la conversation continue: pas besoin de redire "Jarvis"
avant chaque phrase, ni de repeter de quoi on parle.

Trois mecanismes:

* l'historique des tours, tronque proprement pour rester dans le contexte;
* le `focus`: la derniere liste d'objets mentionnee (meetings, courriels...),
  ce qui permet de resoudre "le deuxieme", "celui-la", "le dernier";
* les faits de session: informations dites pendant la conversation courante.

La troncature est faite avec soin: on ne coupe jamais entre un appel d'outil et
son resultat, sinon l'API rejette la conversation.
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from jarvis_core.llm.base import LLMMessage, TextBlock, ToolCall, ToolResultBlock

#: Nombre maximum de messages conserves dans l'historique actif.
DEFAULT_MAX_MESSAGES = 30

_ORDINALS: dict[str, int] = {
    "premier": 0, "premiere": 0, "1er": 0, "1ere": 0, "first": 0,
    "deuxieme": 1, "second": 1, "seconde": 1, "2e": 1, "2eme": 1, "second_en": 1,
    "troisieme": 2, "3e": 2, "3eme": 2, "third": 2,
    "quatrieme": 3, "4e": 3, "4eme": 3, "fourth": 3,
    "cinquieme": 4, "5e": 4, "5eme": 4, "fifth": 4,
}


def _strip_accents(text: str) -> str:
    table = str.maketrans("àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ", "aaaeeeeiioouuucAAAEEEEIIOOUUUC")
    return text.translate(table)


@dataclass
class ReferencedItem:
    """Un objet mentionne dans une reponse, referencable ensuite."""

    kind: str
    ref_id: str
    label: str
    payload: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "ref_id": self.ref_id,
            "label": self.label,
            "payload": self.payload,
        }


@dataclass
class SessionFact:
    """Fait etabli pendant la conversation courante."""

    text: str
    source: str
    confidence: float = 0.8
    created_at: float = field(default_factory=time.time)


@dataclass
class PendingAction:
    """Action en attente de confirmation de l'utilisateur."""

    action_id: str
    tool_name: str
    arguments: dict[str, Any]
    tool_call_id: str
    description: str
    permission_level: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "tool": self.tool_name,
            "description": self.description,
            "permission_level": self.permission_level,
        }


class SessionMemory:
    """Etat conversationnel d'une session."""

    def __init__(self, session_id: str, *, max_messages: int = DEFAULT_MAX_MESSAGES) -> None:
        self.session_id = session_id
        self.max_messages = max_messages
        self.messages: list[LLMMessage] = []
        self.focus: list[ReferencedItem] = []
        self.focus_kind: str = ""
        self.facts: list[SessionFact] = []
        self.pending: dict[str, PendingAction] = {}
        self.created_at = time.time()
        self.last_activity = time.time()
        self.organization = "PERSONAL"

    # -- historique ----------------------------------------------------------

    def add_user_text(self, text: str) -> None:
        self.messages.append(LLMMessage.user_text(text))
        self._touch()

    def add_assistant(self, text: str, tool_calls: list[ToolCall] | None = None) -> None:
        content: list[Any] = []
        if text:
            content.append(TextBlock(text=text))
        content.extend(tool_calls or [])
        if not content:
            return
        self.messages.append(LLMMessage(role="assistant", content=content))
        self._touch()

    def add_tool_results(self, results: list[ToolResultBlock]) -> None:
        if not results:
            return
        self.messages.append(LLMMessage(role="user", content=list(results)))
        self._touch()

    def history(self) -> list[LLMMessage]:
        """Historique pret a etre envoye au modele (deja tronque)."""
        self._trim()
        return self.messages

    def _touch(self) -> None:
        self.last_activity = time.time()
        self._trim()

    def _trim(self) -> None:
        """Tronque l'historique sans casser les paires appel/resultat d'outil."""
        if len(self.messages) <= self.max_messages:
            return
        self.messages = self.messages[-self.max_messages :]
        # L'historique doit commencer par un message `user` qui n'est pas un
        # resultat d'outil orphelin.
        while self.messages:
            first = self.messages[0]
            orphan_result = any(isinstance(b, ToolResultBlock) for b in first.content)
            if first.role != "user" or orphan_result:
                self.messages.pop(0)
                continue
            break

    # -- focus / references --------------------------------------------------

    def set_focus(self, kind: str, items: list[ReferencedItem]) -> None:
        """Enregistre la derniere liste presentee a l'utilisateur."""
        if not items:
            return
        self.focus_kind = kind
        self.focus = items

    def resolve_reference(self, phrase: str) -> ReferencedItem | None:
        """Resout "le deuxieme", "le dernier", "celui-la" sur le focus courant.

        Retourne `None` si la reference est ambigue: dans ce cas JARVIS demande
        une precision plutot que de deviner.
        """
        if not self.focus:
            return None
        text = _strip_accents(phrase.lower())

        for word, index in _ORDINALS.items():
            if re.search(rf"\b{re.escape(word)}\b", text) and index < len(self.focus):
                return self.focus[index]

        number = re.search(r"\b(?:numero|no\.?|#)\s*(\d{1,2})\b", text)
        if number:
            index = int(number.group(1)) - 1
            if 0 <= index < len(self.focus):
                return self.focus[index]

        if re.search(r"\b(le dernier|la derniere|the last)\b", text):
            return self.focus[-1]
        if re.search(r"\b(le premier|la premiere|the first)\b", text):
            return self.focus[0]
        if len(self.focus) == 1 and re.search(
            r"\b(celui|celle|ca|le|la|it|that one)\b", text
        ):
            return self.focus[0]
        return None

    def focus_block(self) -> str:
        """Description textuelle du focus, injectee dans le contexte du modele."""
        if not self.focus:
            return ""
        lines = [f"Derniers elements presentes ({self.focus_kind}):"]
        for index, item in enumerate(self.focus, start=1):
            lines.append(f"  {index}. [{item.ref_id}] {item.label}")
        lines.append(
            "Si l'utilisateur dit \"le deuxieme\", \"celui-la\" ou \"le dernier\", "
            "il parle de cette liste."
        )
        return "\n".join(lines)

    # -- faits de session ----------------------------------------------------

    def add_fact(self, text: str, source: str, confidence: float = 0.8) -> SessionFact:
        fact = SessionFact(text=text, source=source, confidence=confidence)
        self.facts.append(fact)
        return fact

    def facts_block(self) -> str:
        if not self.facts:
            return ""
        lines = ["Etabli pendant cette conversation:"]
        lines.extend(f"  - {fact.text} (source: {fact.source})" for fact in self.facts[-10:])
        return "\n".join(lines)

    # -- confirmations -------------------------------------------------------

    def add_pending(self, action: PendingAction) -> None:
        self.pending[action.action_id] = action

    def take_pending(self, action_id: str) -> PendingAction | None:
        return self.pending.pop(action_id, None)

    def take_latest_pending(self) -> PendingAction | None:
        if not self.pending:
            return None
        action_id = next(reversed(self.pending))
        return self.pending.pop(action_id)

    def clear_pending(self) -> None:
        self.pending.clear()

    # -- divers --------------------------------------------------------------

    def reset(self) -> None:
        self.messages.clear()
        self.focus.clear()
        self.focus_kind = ""
        self.facts.clear()
        self.pending.clear()

    def snapshot(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "messages": len(self.messages),
            "focus_kind": self.focus_kind,
            "focus": [item.as_dict() for item in self.focus],
            "facts": [f.text for f in self.facts],
            "pending": [a.as_dict() for a in self.pending.values()],
            "organization": self.organization,
        }


class SessionStore:
    """Collection de sessions en memoire, avec expiration."""

    def __init__(self, *, ttl_seconds: int = 60 * 60 * 6) -> None:
        self._sessions: dict[str, SessionMemory] = {}
        self._ttl = ttl_seconds

    def get_or_create(self, session_id: str | None = None) -> SessionMemory:
        self._evict_expired()
        sid = session_id or f"s_{uuid.uuid4().hex[:12]}"
        session = self._sessions.get(sid)
        if session is None:
            session = SessionMemory(sid)
            self._sessions[sid] = session
        return session

    def get(self, session_id: str) -> SessionMemory | None:
        return self._sessions.get(session_id)

    def drop(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def _evict_expired(self) -> None:
        cutoff = time.time() - self._ttl
        expired = [sid for sid, s in self._sessions.items() if s.last_activity < cutoff]
        for sid in expired:
            del self._sessions[sid]

    def count(self) -> int:
        return len(self._sessions)
