"""Surveillance proactive: quand JARVIS parle sans qu'on lui demande.

C'est la fonctionnalite la plus facile a rendre insupportable.  Trois regles la
gouvernent.

**Ne jamais inventer une raison d'interrompre.**  Un observateur dont la source
n'est pas branchee ne produit rien.  Pas « tu n'as aucune reunion » — rien du
tout.  Le silence est le comportement correct quand on ne sait pas.

**Ne jamais repeter.**  Chaque alerte porte une cle de deduplication stable:
la meme reunion ne peut alerter qu'une fois, meme si la surveillance tourne
toutes les cinq minutes.

**Ne signaler que ce sur quoi on peut agir.**  Une organisation qui n'a jamais
eu de donnees n'est pas une nouvelle; une organisation dont les donnees se sont
arretees, si.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from jarvis_core.persistence.db import Database
from jarvis_core.timeutils import get_tz

logger = logging.getLogger(__name__)

INFO = "info"
ATTENTION = "attention"

#: Fenetre d'annonce d'une reunion: assez tot pour se preparer, assez tard pour
#: que ce soit encore pertinent.
MEETING_LEAD_MINUTES = 15
#: Au-dela, des donnees business qui ne bougent plus meritent d'etre signalees.
BUSINESS_STALE_DAYS = 10
#: Une alerte disparait d'elle-meme apres ce delai.
DEFAULT_TTL_HOURS = 12


@dataclass
class Alert:
    """Quelque chose que JARVIS a remarque et qui merite d'etre dit."""

    kind: str
    title: str
    source: str
    dedup_key: str
    detail: str = ""
    severity: str = INFO
    ttl_hours: int = DEFAULT_TTL_HOURS

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "title": self.title,
            "detail": self.detail,
            "severity": self.severity,
            "source": self.source,
        }


class AlertStore:
    """Conserve les alertes et empeche les doublons."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def record(self, alerts: list[Alert]) -> list[dict[str, Any]]:
        """Enregistre les alertes nouvelles. Retourne uniquement celles-la.

        Une alerte deja connue est ignoree silencieusement: c'est ce qui
        empeche la surveillance de repeter la meme chose toutes les cinq
        minutes.
        """
        if not alerts:
            return []
        now = datetime.now(UTC)
        fresh: list[dict[str, Any]] = []
        with self.db.cursor() as cur:
            for alert in alerts:
                alert_id = f"al_{uuid.uuid4().hex[:12]}"
                expires = (now + timedelta(hours=alert.ttl_hours)).isoformat()
                cur.execute(
                    "INSERT OR IGNORE INTO alerts"
                    " (id, kind, severity, title, detail, source, dedup_key,"
                    "  created_at, expires_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        alert_id,
                        alert.kind,
                        alert.severity,
                        alert.title,
                        alert.detail,
                        alert.source,
                        alert.dedup_key,
                        now.isoformat(),
                        expires,
                    ),
                )
                if cur.rowcount:
                    fresh.append({**alert.as_dict(), "id": alert_id, "created_at": now.isoformat()})
        return fresh

    def active(self, *, limit: int = 20) -> list[dict[str, Any]]:
        """Alertes non expirees, les plus recentes d'abord."""
        now = datetime.now(UTC).isoformat()
        rows = self.db.query(
            "SELECT * FROM alerts WHERE expires_at = '' OR expires_at > ?"
            " ORDER BY created_at DESC LIMIT ?",
            (now, limit),
        )
        return [
            {
                "id": str(row["id"]),
                "kind": str(row["kind"]),
                "severity": str(row["severity"]),
                "title": str(row["title"]),
                "detail": str(row["detail"]),
                "source": str(row["source"]),
                "created_at": str(row["created_at"]),
                "seen": bool(str(row["seen_at"])),
            }
            for row in rows
        ]

    def mark_seen(self, alert_id: str) -> bool:
        if not self.db.query_one("SELECT id FROM alerts WHERE id = ?", (alert_id,)):
            return False
        self.db.execute(
            "UPDATE alerts SET seen_at = ? WHERE id = ?",
            (datetime.now(UTC).isoformat(), alert_id),
        )
        return True

    def dismiss_all(self) -> int:
        rows = self.db.query("SELECT COUNT(*) AS n FROM alerts")
        self.db.execute("DELETE FROM alerts")
        return int(rows[0]["n"]) if rows else 0

    def purge_expired(self) -> int:
        now = datetime.now(UTC).isoformat()
        rows = self.db.query(
            "SELECT COUNT(*) AS n FROM alerts WHERE expires_at != '' AND expires_at <= ?",
            (now,),
        )
        self.db.execute("DELETE FROM alerts WHERE expires_at != '' AND expires_at <= ?", (now,))
        return int(rows[0]["n"]) if rows else 0


# --------------------------------------------------------------- observateurs


async def watch_calendar(runtime: Any) -> list[Alert]:
    """Reunion sur le point de commencer.

    Ne produit rien si le calendrier n'est pas branche: JARVIS ne dit pas
    « tu n'as rien » quand il n'a simplement pas regarde.
    """
    google = getattr(runtime, "google", None)
    if google is None or not google.connected or not runtime.settings.feature_calendar:
        return []

    now = datetime.now(get_tz(runtime.settings.timezone))
    horizon = now + timedelta(minutes=MEETING_LEAD_MINUTES)
    try:
        events = await google.calendar.list_events(
            start=now.isoformat(), end=horizon.isoformat(), limit=5
        )
    except Exception as exc:  # noqa: BLE001 - une panne d'API n'est pas une alerte
        logger.warning("surveillance calendrier impossible: %s", exc)
        return []

    alerts: list[Alert] = []
    for event in events:
        starts = getattr(event, "start", "")
        title = getattr(event, "title", "") or "(sans titre)"
        minutes = _minutes_until(starts, now)
        if minutes is None or minutes < 0:
            continue
        when = "maintenant" if minutes <= 1 else f"dans {minutes} minutes"
        alerts.append(
            Alert(
                kind="calendar",
                severity=ATTENTION,
                title=f"{title} commence {when}",
                detail=getattr(event, "location", "") or "",
                source="Google Calendar",
                dedup_key=f"meeting:{getattr(event, 'id', title)}",
                ttl_hours=2,
            )
        )
    return alerts


def watch_reminders(runtime: Any) -> list[Alert]:
    """Rappels arrives a echeance. Source locale: toujours disponible."""
    reminders = getattr(runtime, "reminders", None)
    if reminders is None:
        return []
    now = datetime.now(get_tz(runtime.settings.timezone))
    try:
        due = reminders.due_before(now.isoformat())
    except Exception as exc:  # noqa: BLE001
        logger.warning("surveillance des rappels impossible: %s", exc)
        return []

    return [
        Alert(
            kind="reminder",
            severity=ATTENTION,
            title=reminder.text,
            detail=f"Echeance: {reminder.due_label or reminder.due_at}",
            source="Rappels",
            dedup_key=f"reminder:{reminder.id}",
            ttl_hours=24,
        )
        for reminder in due
    ]


def watch_business(runtime: Any) -> list[Alert]:
    """Donnees business qui se sont arretees.

    On ne signale que les organisations qui **ont deja eu** des donnees. Une
    organisation jamais branchee n'est pas une nouvelle, c'est l'etat normal.
    """
    store = getattr(runtime, "business", None)
    if store is None:
        return []

    today = datetime.now(get_tz(runtime.settings.timezone)).date()
    alerts: list[Alert] = []
    rows = runtime.db.query(
        "SELECT id, name FROM organizations"
            " WHERE id != 'PERSONAL' AND archived = 0 ORDER BY position, name"
    )
    for row in rows:
        org_id, name = str(row["id"]), str(row["name"])
        latest = store.latest_day(org_id)
        if not latest:
            continue  # jamais branchee: rien a signaler
        try:
            age = (today - datetime.fromisoformat(latest).date()).days
        except ValueError:
            continue
        if age < BUSINESS_STALE_DAYS:
            continue
        alerts.append(
            Alert(
                kind="business",
                severity=INFO,
                title=f"{name}: aucune donnee depuis {age} jours",
                detail=f"Derniere donnee le {latest}. Importe un export recent.",
                source="Donnees business",
                # La cle inclut la semaine: on re-signale au plus une fois par
                # semaine plutot qu'une fois pour toutes.
                dedup_key=f"stale:{org_id}:{today.isocalendar()[1]}",
                ttl_hours=48,
            )
        )
    return alerts


async def collect_alerts(runtime: Any) -> list[Alert]:
    """Fait tourner tous les observateurs. Un echec n'en bloque aucun autre."""
    alerts: list[Alert] = []
    try:
        alerts.extend(await watch_calendar(runtime))
    except Exception as exc:  # noqa: BLE001
        logger.warning("observateur calendrier en echec: %s", exc)
    for watcher in (watch_reminders, watch_business):
        try:
            alerts.extend(watcher(runtime))
        except Exception as exc:  # noqa: BLE001
            logger.warning("observateur %s en echec: %s", watcher.__name__, exc)
    return alerts


def _minutes_until(iso_start: str, now: datetime) -> int | None:
    """Minutes avant le debut, ou None si la date est illisible."""
    if not iso_start:
        return None
    try:
        start = datetime.fromisoformat(iso_start)
    except ValueError:
        return None
    if start.tzinfo is None:
        start = start.replace(tzinfo=now.tzinfo)
    return int((start - now).total_seconds() // 60)
