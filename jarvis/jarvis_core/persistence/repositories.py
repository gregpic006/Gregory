"""Depots de donnees applicatifs (hors memoire)."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from jarvis_core.persistence.db import Database
from jarvis_core.security.audit import AuditEntry


@dataclass
class Reminder:
    """Un rappel programme."""

    id: str
    org_id: str
    text: str
    due_at: str
    due_label: str
    status: str
    created_at: str
    completed_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "due_at": self.due_at,
            "due_label": self.due_label,
            "status": self.status,
        }


class ReminderRepository:
    """CRUD des rappels."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self, *, text: str, due_at: str, due_label: str = "", org_id: str = "PERSONAL"
    ) -> Reminder:
        reminder = Reminder(
            id=f"r_{uuid.uuid4().hex[:10]}",
            org_id=org_id,
            text=text.strip(),
            due_at=due_at,
            due_label=due_label,
            status="pending",
            created_at=datetime.now(UTC).isoformat(),
        )
        self.db.execute(
            "INSERT INTO reminders (id, org_id, text, due_at, due_label, status, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (
                reminder.id, reminder.org_id, reminder.text, reminder.due_at,
                reminder.due_label, reminder.status, reminder.created_at,
            ),
        )
        return reminder

    def list_pending(self, *, org_id: str | None = None, limit: int = 20) -> list[Reminder]:
        sql = "SELECT * FROM reminders WHERE status = 'pending'"
        params: tuple[Any, ...] = ()
        if org_id:
            sql += " AND org_id = ?"
            params = (org_id,)
        sql += " ORDER BY due_at ASC LIMIT ?"
        return [_row_to_reminder(row) for row in self.db.query(sql, (*params, limit))]

    def due_before(self, iso_timestamp: str) -> list[Reminder]:
        rows = self.db.query(
            "SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at",
            (iso_timestamp,),
        )
        return [_row_to_reminder(row) for row in rows]

    def complete(self, reminder_id: str) -> bool:
        row = self.db.query_one("SELECT id FROM reminders WHERE id = ?", (reminder_id,))
        if row is None:
            return False
        self.db.execute(
            "UPDATE reminders SET status = 'done', completed_at = ? WHERE id = ?",
            (datetime.now(UTC).isoformat(), reminder_id),
        )
        return True

    def cancel(self, reminder_id: str) -> bool:
        row = self.db.query_one("SELECT id FROM reminders WHERE id = ?", (reminder_id,))
        if row is None:
            return False
        self.db.execute("UPDATE reminders SET status = 'cancelled' WHERE id = ?", (reminder_id,))
        return True


def _row_to_reminder(row: Any) -> Reminder:
    return Reminder(
        id=row["id"],
        org_id=row["org_id"],
        text=row["text"],
        due_at=row["due_at"],
        due_label=row["due_label"],
        status=row["status"],
        created_at=row["created_at"],
        completed_at=row["completed_at"],
    )


class SqliteAuditSink:
    """Destination d'audit persistante."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def write(self, entry: AuditEntry) -> None:
        self.db.execute(
            "INSERT INTO audit_logs (id, timestamp, session_id, user_request, tool, action,"
            " parameters, permission_level, decision, confirmed, status, duration_ms,"
            " result_summary, error, injection_signals)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"a_{uuid.uuid4().hex[:12]}",
                entry.timestamp,
                entry.session_id,
                entry.user_request,
                entry.tool,
                entry.action,
                json.dumps(entry.parameters, ensure_ascii=False),
                entry.permission_level,
                entry.decision,
                int(entry.confirmed),
                entry.status,
                entry.duration_ms,
                entry.result_summary,
                entry.error,
                json.dumps(entry.injection_signals, ensure_ascii=False),
            ),
        )

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.db.query(
            "SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?", (limit,)
        )
        return [
            {
                "id": row["id"],
                "timestamp": row["timestamp"],
                "session_id": row["session_id"],
                "tool": row["tool"],
                "action": row["action"],
                "permission_level": row["permission_level"],
                "decision": row["decision"],
                "confirmed": bool(row["confirmed"]),
                "status": row["status"],
                "duration_ms": row["duration_ms"],
                "result_summary": row["result_summary"],
                "error": row["error"],
            }
            for row in rows
        ]
