"""Tests de la piste d'audit.

L'audit qui fait foi est celui de la base. La destination "logs" ne doit pas
polluer la conversation, et aucune destination ne doit recopier un contenu
sensible en clair.
"""

from __future__ import annotations

import logging

from jarvis_core.persistence.db import Database
from jarvis_core.persistence.repositories import SqliteAuditSink
from jarvis_core.security.audit import AuditTrail, LoggingAuditSink, summarize_params


def _record(trail: AuditTrail, **overrides: object) -> None:
    payload: dict[str, object] = {
        "session_id": "s1",
        "user_request": "envoie un courriel a Xavier",
        "tool": "send_email",
        "action": "execute",
        "parameters": {"to": ["xavier@example.com"], "body": "x" * 500},
        "permission_level": 2,
        "decision": "confirm",
        "confirmed": True,
        "status": "ok",
        "duration_ms": 12,
    }
    payload.update(overrides)
    trail.record(**payload)  # type: ignore[arg-type]


def test_audit_is_written_to_the_database(db: Database) -> None:
    sink = SqliteAuditSink(db)
    _record(AuditTrail([sink]))
    entries = sink.recent()
    assert len(entries) == 1
    assert entries[0]["tool"] == "send_email"
    assert entries[0]["confirmed"] is True
    assert entries[0]["permission_level"] == 2


def test_logging_sink_stays_quiet_at_info(caplog) -> None:  # type: ignore[no-untyped-def]
    """Le journal d'audit ne doit pas s'afficher au milieu d'une conversation."""
    with caplog.at_level(logging.INFO, logger="jarvis.audit"):
        _record(AuditTrail([LoggingAuditSink()]))
    assert caplog.records == []


def test_logging_sink_is_available_when_debugging(caplog) -> None:  # type: ignore[no-untyped-def]
    with caplog.at_level(logging.DEBUG, logger="jarvis.audit"):
        _record(AuditTrail([LoggingAuditSink()]))
    assert any("send_email" in record.getMessage() for record in caplog.records)


def test_message_bodies_are_never_stored_verbatim(db: Database) -> None:
    """On journalise qu'un corps existait et sa taille, pas son contenu."""
    sink = SqliteAuditSink(db)
    _record(AuditTrail([sink]), parameters={"to": ["x@example.com"], "body": "SECRET" * 50})
    assert "SECRET" not in str(sink.recent()[0])


def test_secrets_in_parameters_are_redacted() -> None:
    summary = summarize_params({"note": "ma cle est sk-ant-api03-abcdefghijklmnopqrstuvwx"})
    assert "sk-ant-api03-abcdefghijklmnopqrstuvwx" not in str(summary)


def test_a_failing_sink_never_breaks_the_turn(db: Database) -> None:
    """Un audit casse ne doit jamais faire echouer une demande de l'utilisateur."""

    class BrokenSink:
        def write(self, entry: object) -> None:
            raise RuntimeError("disque plein")

    working = SqliteAuditSink(db)
    _record(AuditTrail([BrokenSink(), working]))  # type: ignore[list-item]
    assert len(working.recent()) == 1
