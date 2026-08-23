"""Piste d'audit: qui a demande quoi, quel outil a tourne, avec quel resultat.

On journalise systematiquement les metadonnees (outil, palier, decision,
statut, duree) et on evite d'ecrire le contenu sensible complet: les parametres
sont resumes et les motifs ressemblant a des secrets sont masques.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from jarvis_core.security.sanitize import redact_secrets

logger = logging.getLogger("jarvis.audit")

#: Cles dont la valeur n'est jamais journalisee integralement.
SENSITIVE_KEYS = frozenset(
    {"body", "content", "message", "text", "password", "token", "api_key", "attachment"}
)


def summarize_params(params: dict[str, Any], *, max_len: int = 120) -> dict[str, Any]:
    """Reduit les parametres d'un outil a une forme journalisable."""
    summary: dict[str, Any] = {}
    for key, value in params.items():
        if key.lower() in SENSITIVE_KEYS and isinstance(value, str):
            summary[key] = f"<{len(value)} caracteres>"
            continue
        if isinstance(value, str):
            cleaned = redact_secrets(value)
            summary[key] = cleaned if len(cleaned) <= max_len else cleaned[:max_len] + "…"
        elif isinstance(value, (int, float, bool)) or value is None:
            summary[key] = value
        elif isinstance(value, list):
            summary[key] = f"<liste de {len(value)}>"
        elif isinstance(value, dict):
            summary[key] = f"<objet {len(value)} cles>"
        else:  # pragma: no cover - defensif
            summary[key] = f"<{type(value).__name__}>"
    return summary


@dataclass
class AuditEntry:
    """Une ligne d'audit."""

    timestamp: str
    session_id: str
    user_request: str
    tool: str
    action: str
    parameters: dict[str, Any]
    permission_level: int
    decision: str
    confirmed: bool
    status: str
    duration_ms: int
    result_summary: str = ""
    error: str = ""
    injection_signals: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class AuditSink(Protocol):
    """Destination d'ecriture des entrees d'audit."""

    def write(self, entry: AuditEntry) -> None: ...


class LoggingAuditSink:
    """Ecrit l'audit dans les logs applicatifs (utile en dev et en test)."""

    def write(self, entry: AuditEntry) -> None:
        logger.info("audit %s", json.dumps(entry.as_dict(), ensure_ascii=False))


class AuditTrail:
    """Facade d'ecriture; accepte plusieurs destinations (logs + base)."""

    def __init__(self, sinks: list[AuditSink] | None = None) -> None:
        self._sinks: list[AuditSink] = sinks or [LoggingAuditSink()]

    def add_sink(self, sink: AuditSink) -> None:
        self._sinks.append(sink)

    def record(
        self,
        *,
        session_id: str,
        user_request: str,
        tool: str,
        action: str,
        parameters: dict[str, Any],
        permission_level: int,
        decision: str,
        confirmed: bool,
        status: str,
        duration_ms: int,
        result_summary: str = "",
        error: str = "",
        injection_signals: list[str] | None = None,
    ) -> AuditEntry:
        entry = AuditEntry(
            timestamp=datetime.now(UTC).isoformat(),
            session_id=session_id,
            user_request=redact_secrets(user_request)[:500],
            tool=tool,
            action=action,
            parameters=summarize_params(parameters),
            permission_level=permission_level,
            decision=decision,
            confirmed=confirmed,
            status=status,
            duration_ms=duration_ms,
            result_summary=redact_secrets(result_summary)[:300],
            error=redact_secrets(error)[:300],
            injection_signals=injection_signals or [],
        )
        for sink in self._sinks:
            try:
                sink.write(entry)
            except Exception:  # pragma: no cover - l'audit ne doit jamais casser un tour
                logger.exception("echec d'ecriture d'une entree d'audit")
        return entry
