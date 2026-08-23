"""Contrat commun a tous les fournisseurs de LLM.

Le reste de JARVIS ne connait que ces types.  Changer de fournisseur revient a
ecrire une nouvelle implementation de `LLMProvider`, sans toucher a
l'orchestrateur, aux outils ou a la memoire.
"""

from __future__ import annotations

import abc
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal


class TaskTier(StrEnum):
    """Niveau de complexite d'une tache, utilise pour le routage de modele."""

    FAST = "fast"
    """Classification, reformulation, commandes simples: petit modele."""

    BALANCED = "balanced"
    """Conversation avec outils: modele principal."""

    DEEP = "deep"
    """Analyse documentaire, raisonnement multi-etapes: modele le plus capable."""


@dataclass(frozen=True)
class ToolSpec:
    """Description d'un outil telle que transmise au modele."""

    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class TextBlock:
    text: str
    type: Literal["text"] = "text"


@dataclass(frozen=True)
class ToolCall:
    """Demande d'appel d'outil emise par le modele."""

    id: str
    name: str
    arguments: dict[str, Any]
    type: Literal["tool_call"] = "tool_call"


@dataclass(frozen=True)
class ToolResultBlock:
    """Resultat renvoye au modele apres execution d'un outil."""

    tool_call_id: str
    content: str
    is_error: bool = False
    type: Literal["tool_result"] = "tool_result"


ContentBlock = TextBlock | ToolCall | ToolResultBlock


@dataclass
class LLMMessage:
    """Un tour de conversation, cote `user` ou `assistant`."""

    role: Literal["user", "assistant"]
    content: list[ContentBlock]

    @classmethod
    def user_text(cls, text: str) -> LLMMessage:
        return cls(role="user", content=[TextBlock(text=text)])

    @classmethod
    def assistant_text(cls, text: str) -> LLMMessage:
        return cls(role="assistant", content=[TextBlock(text=text)])

    @property
    def text(self) -> str:
        return "\n".join(b.text for b in self.content if isinstance(b, TextBlock))


@dataclass(frozen=True)
class Usage:
    """Consommation d'un appel, utilisee par le suivi de couts."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def __add__(self, other: Usage) -> Usage:
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_read_tokens=self.cache_read_tokens + other.cache_read_tokens,
            cache_write_tokens=self.cache_write_tokens + other.cache_write_tokens,
        )


@dataclass
class LLMResponse:
    """Reponse normalisee d'un fournisseur."""

    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = "end_turn"
    model: str = ""
    usage: Usage = field(default_factory=Usage)
    latency_ms: int = 0
    raw_content: list[ContentBlock] = field(default_factory=list)

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


#: Callback appele pour chaque fragment de texte genere (streaming).
StreamCallback = Callable[[str], Awaitable[None]]


@dataclass
class AssistantTurn:
    """Vue simplifiee d'un tour assistant, pour la memoire de session."""

    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)


class LLMProvider(abc.ABC):
    """Interface que tout fournisseur doit implementer."""

    name: str = "abstract"

    @abc.abstractmethod
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
        """Produit une reponse.

        Args:
            model: identifiant de modele propre au fournisseur.
            system: instructions systeme (autorite la plus haute).
            messages: historique de conversation normalise.
            tools: outils disponibles pour ce tour.
            max_tokens: plafond de generation.
            effort: profondeur de raisonnement demandee (`low`..`max`),
                ignoree par les fournisseurs qui ne la supportent pas.
            on_text: callback de streaming; recoit les fragments de texte.

        Raises:
            LLMError: en cas d'echec reseau, de quota ou de refus.
        """

    async def aclose(self) -> None:
        """Libere les ressources reseau. Surcharge optionnelle."""
        return None
