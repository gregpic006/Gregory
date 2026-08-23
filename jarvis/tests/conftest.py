"""Fixtures partagees.

`ScriptedLLM` remplace le modele par une file de reponses predefinies: les
tests verifient le comportement de l'orchestrateur (permissions, isolation du
contenu externe, gestion d'erreur) sans dependre d'un appel reseau.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from jarvis_core.config import Settings
from jarvis_core.llm.base import (
    LLMMessage,
    LLMProvider,
    LLMResponse,
    StreamCallback,
    TextBlock,
    ToolCall,
    ToolSpec,
    Usage,
)
from jarvis_core.llm.router import LLMRouter
from jarvis_core.memory.store import MemoryStore
from jarvis_core.orchestrator.orchestrator import JarvisOrchestrator
from jarvis_core.persistence.db import Database
from jarvis_core.persistence.repositories import ReminderRepository
from jarvis_core.security.audit import AuditTrail, LoggingAuditSink
from jarvis_core.security.permissions import PermissionPolicy
from jarvis_core.tools.registry import registry as global_registry


class ScriptedLLM(LLMProvider):
    """Fournisseur de test: rend les reponses programmees, dans l'ordre."""

    name = "scripted"

    def __init__(self, responses: list[LLMResponse] | None = None) -> None:
        self.responses: list[LLMResponse] = responses or []
        self.calls: list[dict[str, Any]] = []

    def queue_text(self, text: str) -> None:
        self.responses.append(
            LLMResponse(text=text, model="scripted", raw_content=[TextBlock(text=text)])
        )

    def queue_tool(self, name: str, arguments: dict[str, Any], *, text: str = "") -> None:
        call = ToolCall(id=f"t_{uuid.uuid4().hex[:8]}", name=name, arguments=arguments)
        self.responses.append(
            LLMResponse(
                text=text,
                tool_calls=[call],
                stop_reason="tool_use",
                model="scripted",
                raw_content=[call],
            )
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
        self.calls.append(
            {
                "system": system,
                "messages": list(messages),
                "tools": [t.name for t in (tools or [])],
                "model": model,
            }
        )
        if not self.responses:
            return LLMResponse(text="(fin du script)", model=model, usage=Usage())
        response = self.responses.pop(0)
        if response.text and on_text is not None:
            await on_text(response.text)
        return response

    @property
    def last_system_prompt(self) -> str:
        return self.calls[-1]["system"] if self.calls else ""

    @property
    def last_messages(self) -> list[LLMMessage]:
        return self.calls[-1]["messages"] if self.calls else []

    @property
    def last_tool_results(self) -> str:
        """Concatene le contenu des blocs tool_result du dernier appel.

        C'est ce que le modele voit reellement quand un outil a repondu.
        """
        from jarvis_core.llm.base import ToolResultBlock

        parts: list[str] = []
        for message in self.last_messages:
            parts.extend(
                block.content
                for block in message.content
                if isinstance(block, ToolResultBlock)
            )
        return "\n".join(parts)


@pytest.fixture()
def settings() -> Settings:
    """Configuration de test: tout en memoire, aucune integration externe."""
    return Settings(
        JARVIS_NAME="Jarvis",
        JARVIS_USER_NAME="Greg",
        JARVIS_TIMEZONE="America/Montreal",
        JARVIS_ENV="development",
        JARVIS_DRY_RUN=True,
        JARVIS_LLM_PROVIDER="mock",
        JARVIS_DATABASE_URL="sqlite:///:memory:",
        JARVIS_AUTO_APPROVE_MAX_LEVEL=1,
        JARVIS_FEATURE_PERSISTENT_MEMORY=True,
        JARVIS_FEATURE_GMAIL=False,
        JARVIS_FEATURE_CALENDAR=False,
        JARVIS_LLM_DAILY_BUDGET_USD=0.0,
    )


@pytest.fixture()
def db() -> Iterator[Database]:
    database = Database(":memory:")
    database.migrate()
    yield database
    database.close()


@pytest.fixture(autouse=True)
def _load_tools() -> None:
    """Garantit que les outils sont enregistres avant chaque test."""
    import jarvis_core.tools.builtin  # noqa: F401
    import jarvis_core.tools.google  # noqa: F401


@pytest.fixture()
def llm() -> ScriptedLLM:
    return ScriptedLLM()


@pytest.fixture()
def orchestrator(
    settings: Settings, db: Database, llm: ScriptedLLM
) -> JarvisOrchestrator:
    return JarvisOrchestrator(
        settings=settings,
        router=LLMRouter(llm, settings),
        registry=global_registry,
        policy=PermissionPolicy(),
        audit=AuditTrail([LoggingAuditSink()]),
        memory_store=MemoryStore(db),
        reminders=ReminderRepository(db),
    )
