"""Assemblage de l'application.

Un seul endroit ou les sous-systemes sont cables ensemble.  L'API, la CLI et
les tests construisent tous un `JarvisRuntime`; personne d'autre n'a besoin de
connaitre l'ordre de construction.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from jarvis_core.config import Settings, get_settings
from jarvis_core.llm.router import LLMRouter, build_router
from jarvis_core.memory.session import SessionStore
from jarvis_core.memory.store import MemoryStore
from jarvis_core.observability.metrics import Metrics
from jarvis_core.orchestrator.orchestrator import JarvisOrchestrator
from jarvis_core.persistence.db import Database, build_database
from jarvis_core.persistence.repositories import ReminderRepository, SqliteAuditSink
from jarvis_core.security.audit import AuditTrail, LoggingAuditSink
from jarvis_core.security.crypto import SecretBox
from jarvis_core.security.permissions import policy_from_settings
from jarvis_core.tools.registry import ToolRegistry
from jarvis_core.tools.registry import registry as global_registry
from jarvis_core.voice.stt.base import SpeechToTextProvider, build_stt
from jarvis_core.voice.tts.base import TextToSpeechProvider, build_tts

logger = logging.getLogger(__name__)


def _load_builtin_tools() -> None:
    """Importe les modules d'outils pour declencher leur enregistrement."""
    import jarvis_core.tools.builtin  # noqa: F401
    import jarvis_core.tools.google  # noqa: F401


@dataclass
class JarvisRuntime:
    """Application assemblee, prete a traiter des tours de conversation."""

    settings: Settings
    db: Database
    registry: ToolRegistry
    router: LLMRouter
    orchestrator: JarvisOrchestrator
    sessions: SessionStore
    memory_store: MemoryStore | None
    reminders: ReminderRepository
    audit_sink: SqliteAuditSink
    stt: SpeechToTextProvider
    tts: TextToSpeechProvider
    metrics: Metrics
    secret_box: SecretBox

    async def aclose(self) -> None:
        await self.router.aclose()
        await self.stt.aclose()
        await self.tts.aclose()
        self.db.close()

    def system_info(self) -> dict[str, Any]:
        """Etat du systeme expose a l'interface."""
        features = self.settings.feature_map()
        tools = [
            {
                "name": tool.name,
                "description": tool.description,
                "permission": int(tool.permission),
                "available": not tool.feature_flag or features.get(tool.feature_flag, False),
                "feature_flag": tool.feature_flag,
            }
            for tool in self.registry.all()
        ]
        return {
            "name": self.settings.jarvis_name,
            "user": self.settings.user_name,
            "language": self.settings.default_language,
            "timezone": self.settings.timezone,
            "env": self.settings.env,
            "dry_run": self.settings.dry_run,
            "features": features,
            "providers": {
                "llm": self.router.provider.name,
                "llm_models": {
                    "fast": self.settings.llm_model_fast,
                    "balanced": self.settings.llm_model_balanced,
                    "deep": self.settings.llm_model_deep,
                },
                "stt": self.stt.name,
                "stt_available": self.stt.available,
                "tts": self.tts.name,
                "tts_available": self.tts.available,
            },
            "tools": sorted(tools, key=lambda item: (not item["available"], item["name"])),
            "auto_approve_max_level": self.settings.auto_approve_max_level,
        }


def build_runtime(settings: Settings | None = None) -> JarvisRuntime:
    """Construit l'application complete."""
    settings = settings or get_settings()
    _load_builtin_tools()

    db = build_database(settings.database_url)
    applied = db.migrate()
    if applied:
        logger.info("migrations appliquees: %s", ", ".join(applied))

    audit_sink = SqliteAuditSink(db)
    audit = AuditTrail([LoggingAuditSink(), audit_sink])

    memory_store = MemoryStore(db) if settings.feature_persistent_memory else None
    reminders = ReminderRepository(db)
    router = build_router(settings)
    secret_box = SecretBox(settings.encryption_key, allow_ephemeral=settings.is_dev)

    orchestrator = JarvisOrchestrator(
        settings=settings,
        router=router,
        registry=global_registry,
        policy=policy_from_settings(settings),
        audit=audit,
        memory_store=memory_store,
        reminders=reminders,
    )

    return JarvisRuntime(
        settings=settings,
        db=db,
        registry=global_registry,
        router=router,
        orchestrator=orchestrator,
        sessions=SessionStore(),
        memory_store=memory_store,
        reminders=reminders,
        audit_sink=audit_sink,
        stt=build_stt(settings),
        tts=build_tts(settings),
        metrics=Metrics(),
        secret_box=secret_box,
    )
