"""Types partages par tous les outils."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from jarvis_core.config import Settings
    from jarvis_core.documents.store import DocumentStore
    from jarvis_core.integrations.google import GoogleWorkspace
    from jarvis_core.memory.session import SessionMemory
    from jarvis_core.memory.store import MemoryStore
    from jarvis_core.persistence.repositories import ReminderRepository


@dataclass(frozen=True)
class Citation:
    """Reference vers la source d'une information.

    Toute donnee affirmee par JARVIS a partir d'un document, d'un courriel ou
    d'une API doit pouvoir remonter a une citation affichable dans l'interface.
    """

    label: str
    kind: str = "document"
    locator: str = ""
    url: str = ""
    timestamp: str = ""

    def as_dict(self) -> dict[str, str]:
        return {
            "label": self.label,
            "kind": self.kind,
            "locator": self.locator,
            "url": self.url,
            "timestamp": self.timestamp,
        }


@dataclass
class ToolResult:
    """Resultat normalise d'un outil.

    Attributes:
        ok: succes de l'execution.
        summary: texte court renvoye au modele.  C'est la seule chose que le
            modele voit; il doit etre factuel et autoportant.
        data: donnees structurees, transmises a l'interface (widgets).
        citations: sources citables.
        untrusted: vrai si `summary` contient du contenu externe (courriel,
            page web, document).  L'orchestrateur l'encapsulera alors dans un
            bloc de donnees non fiables avant de le donner au modele.
        source_label: identifiant de la source, utilise pour l'encapsulation.
        display: indication d'affichage pour l'interface (`list`, `table`...).
    """

    ok: bool
    summary: str
    data: dict[str, Any] = field(default_factory=dict)
    citations: list[Citation] = field(default_factory=list)
    untrusted: bool = False
    source_label: str = ""
    display: str = ""

    @classmethod
    def success(cls, summary: str, **kwargs: Any) -> ToolResult:
        return cls(ok=True, summary=summary, **kwargs)

    @classmethod
    def failure(cls, summary: str, **kwargs: Any) -> ToolResult:
        return cls(ok=False, summary=summary, **kwargs)

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "summary": self.summary,
            "data": self.data,
            "citations": [c.as_dict() for c in self.citations],
            "display": self.display,
        }


@dataclass
class ToolContext:
    """Tout ce dont un outil a besoin pour s'executer.

    Les outils ne lisent jamais la configuration globale directement: ils
    passent par ce contexte, ce qui les rend testables en isolation.
    """

    session_id: str
    settings: Settings
    session: SessionMemory
    memory_store: MemoryStore | None = None
    reminders: ReminderRepository | None = None
    documents: DocumentStore | None = None
    google: GoogleWorkspace | None = None
    dry_run: bool = True
    organization: str = "PERSONAL"
    confirmed: bool = False

    @property
    def timezone(self) -> str:
        return self.settings.timezone
