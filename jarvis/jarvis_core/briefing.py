"""Briefing quotidien.

Un briefing est l'endroit ou l'invention est la plus tentante et la plus
dangereuse: le format appelle des phrases completes et rassurantes, et
personne ne verifie a 7 h du matin.

D'ou la construction en deux temps.  On rassemble d'abord les **faits
disponibles**, chacun avec sa source. On ne demande ensuite au modele que de
les mettre en francais — jamais de les completer.  Une source absente est
mentionnee comme absente, ou tue; elle n'est jamais remplacee par une
supposition plausible.

Sans cle Claude, le briefing existe quand meme: il est simplement compose
mecaniquement. Mieux vaut une liste seche et vraie qu'un paragraphe elegant et
faux.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from jarvis_core.llm.base import LLMMessage, TaskTier
from jarvis_core.persistence.db import Database
from jarvis_core.timeutils import describe_now, get_tz

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """Tu rediges le briefing matinal de Greg, en francais quebecois.

REGLE ABSOLUE: tu ne disposes QUE des faits listes ci-dessous. Tu ne peux rien
ajouter. Pas de chiffre, pas de nom, pas de rendez-vous, pas de courriel qui
n'y figure pas. Si une section est vide ou marquee non disponible, dis-le en
une phrase courte ou n'en parle pas — n'invente jamais de contenu pour combler.

Style: direct, chaleureux, 4 a 8 phrases. Tu t'adresses a Greg. Commence par
la salutation du moment. Termine par ce qui merite son attention en premier.
N'utilise pas de listes a puces, ecris en phrases."""


@dataclass
class BriefingFacts:
    """Ce qu'on a reellement pu rassembler, source par source."""

    greeting: str = ""
    date_label: str = ""
    sections: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    unavailable: list[str] = field(default_factory=list)

    def as_prompt(self) -> str:
        lines = [f"Date: {self.date_label}", ""]
        lines.extend(self.sections or ["Aucun fait disponible."])
        if self.unavailable:
            lines.append("")
            lines.append("Sources non disponibles: " + ", ".join(self.unavailable))
        return "\n".join(lines)

    def as_plain_text(self, user_name: str) -> str:
        """Briefing compose mecaniquement, sans modele. Sec mais exact."""
        head = f"{self.greeting}, {user_name}." if user_name else f"{self.greeting}."
        parts = [f"{head} On est {self.date_label}."]
        parts.extend(self.sections or ["Je n'ai aucune source branchee pour l'instant."])
        if self.unavailable:
            parts.append("Non consulte: " + ", ".join(self.unavailable) + ".")
        return " ".join(parts)


def _describe_event(event: Any) -> str:
    title = getattr(event, "title", "") or "(sans titre)"
    start = str(getattr(event, "start", ""))
    hour = start[11:16] if len(start) >= 16 else ""
    return f"{title} a {hour}" if hour else title


def _describe_message(message: Any) -> str:
    sender = getattr(message, "from_name", "") or getattr(message, "from_email", "") or "inconnu"
    subject = getattr(message, "subject", "") or "(sans objet)"
    return f"{sender} — {subject}"


def _greeting(hour: int) -> str:
    if hour < 12:
        return "Bon matin"
    if hour < 18:
        return "Bon apres-midi"
    return "Bonsoir"


async def gather_facts(runtime: Any) -> BriefingFacts:
    """Rassemble les faits, en notant ce qui n'a pas pu etre consulte."""
    settings = runtime.settings
    clock = describe_now(settings.timezone)
    now = datetime.now(get_tz(settings.timezone))
    facts = BriefingFacts(
        greeting=_greeting(now.hour),
        # « human » est deja en francais lisible (« mardi 25 aout, 7 h 02 »);
        # la date ISO se lit mal a voix haute.
        date_label=clock["human"],
    )

    google = getattr(runtime, "google", None)
    # Une seule verification en tete: les blocs suivants peuvent supposer que
    # `google` existe des lors que `connected` est vrai.
    connected = google is not None and bool(google.connected)

    # --- agenda ---
    if connected and google is not None and settings.feature_calendar:
        try:
            events = await google.calendar.list_events(
                start=now.replace(hour=0, minute=0, second=0).isoformat(),
                end=now.replace(hour=23, minute=59, second=59).isoformat(),
                limit=10,
            )
            if events:
                listed = "; ".join(_describe_event(event) for event in events)
                facts.sections.append(f"Agenda ({len(events)} rendez-vous): {listed}.")
            else:
                facts.sections.append("Agenda: aucun rendez-vous aujourd'hui.")
            facts.sources.append("Google Calendar")
        except Exception as exc:  # noqa: BLE001 - une panne se dit, ne s'invente pas
            logger.warning("briefing: calendrier indisponible: %s", exc)
            facts.unavailable.append("agenda (erreur)")
    else:
        facts.unavailable.append("agenda (non connecte)")

    # --- courriels ---
    if connected and google is not None and settings.feature_gmail:
        try:
            messages = await google.gmail.search("is:unread in:inbox", limit=8)
            if messages:
                senders = "; ".join(_describe_message(m) for m in messages[:5])
                facts.sections.append(f"Courriels non lus ({len(messages)}): {senders}.")
            else:
                facts.sections.append("Courriels: aucun non lu.")
            facts.sources.append("Gmail")
        except Exception as exc:  # noqa: BLE001
            logger.warning("briefing: Gmail indisponible: %s", exc)
            facts.unavailable.append("courriels (erreur)")
    else:
        facts.unavailable.append("courriels (non connecte)")

    # --- rappels (source locale, toujours la) ---
    reminders = getattr(runtime, "reminders", None)
    if reminders is not None:
        try:
            pending = reminders.list_pending(limit=8)
            if pending:
                listed = "; ".join(f"{r.text} ({r.due_label or r.due_at})" for r in pending)
                facts.sections.append(f"Rappels en attente ({len(pending)}): {listed}.")
            else:
                facts.sections.append("Rappels: rien en attente.")
            facts.sources.append("Rappels")
        except Exception as exc:  # noqa: BLE001
            logger.warning("briefing: rappels indisponibles: %s", exc)

    # --- business ---
    business = getattr(runtime, "business", None)
    if business is not None:
        try:
            summary = _business_summary(runtime, business)
            if summary:
                facts.sections.append(summary)
                facts.sources.append("Donnees business")
        except Exception as exc:  # noqa: BLE001
            logger.warning("briefing: donnees business indisponibles: %s", exc)

    return facts


def _business_summary(runtime: Any, store: Any) -> str:
    """Chiffres de la veille, uniquement pour les organisations branchees."""
    from jarvis_core.business import metrics as vocabulary
    from jarvis_core.business.store import day_range

    today = datetime.now(get_tz(runtime.settings.timezone)).date()
    start, end = day_range(1, end=today)

    pieces: list[str] = []
    rows = runtime.db.query(
        "SELECT id, name, kind FROM organizations"
        " WHERE id != 'PERSONAL' AND archived = 0 ORDER BY position, name"
    )
    for row in rows:
        org_id, name, kind = str(row["id"]), str(row["name"]), str(row["kind"])
        if not store.latest_day(org_id):
            continue  # jamais branchee: on n'en parle pas
        readings = [
            store.read(org_id=org_id, metric=d.key, start=start, end=end, today=today)
            for d in vocabulary.for_kind(kind)
        ]
        available = [r for r in readings if r.value is not None]
        if not available:
            pieces.append(f"{name}: aucune donnee pour aujourd'hui")
            continue
        values = ", ".join(f"{r.label} {r.formatted()}" for r in available)
        pieces.append(f"{name}: {values}")
    return f"Business — {'; '.join(pieces)}." if pieces else ""


class BriefingStore:
    """Conserve les briefings pour pouvoir relire celui du matin."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def save(self, *, day: str, text: str, sources: list[str]) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        self.db.execute(
            "INSERT INTO briefings (id, day, text, sources, created_at) VALUES (?,?,?,?,?)"
            " ON CONFLICT (day) DO UPDATE SET text = excluded.text,"
            " sources = excluded.sources, created_at = excluded.created_at",
            (f"br_{uuid.uuid4().hex[:10]}", day, text, json.dumps(sources), now),
        )
        return {"day": day, "text": text, "sources": sources, "created_at": now}

    def latest(self) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM briefings ORDER BY day DESC LIMIT 1")
        if row is None:
            return None
        return {
            "day": str(row["day"]),
            "text": str(row["text"]),
            "sources": json.loads(str(row["sources"]) or "[]"),
            "created_at": str(row["created_at"]),
        }

    def for_day(self, day: str) -> dict[str, Any] | None:
        row = self.db.query_one("SELECT * FROM briefings WHERE day = ?", (day,))
        if row is None:
            return None
        return {
            "day": str(row["day"]),
            "text": str(row["text"]),
            "sources": json.loads(str(row["sources"]) or "[]"),
            "created_at": str(row["created_at"]),
        }


async def generate_briefing(runtime: Any) -> dict[str, Any]:
    """Produit et enregistre le briefing du jour."""
    facts = await gather_facts(runtime)
    settings = runtime.settings
    text = facts.as_plain_text(settings.user_name)

    router = getattr(runtime, "router", None)
    if router is not None and settings.llm_provider != "mock":
        try:
            response = await router.complete(
                tier=TaskTier.FAST,
                system=SYSTEM_PROMPT,
                messages=[LLMMessage.user_text(facts.as_prompt())],
            )
            written = (getattr(response, "text", "") or "").strip()
            if written:
                text = written
        except Exception as exc:  # noqa: BLE001 - le briefing brut reste valable
            logger.warning("redaction du briefing impossible, version brute conservee: %s", exc)

    day = datetime.now(get_tz(settings.timezone)).date().isoformat()
    store = BriefingStore(runtime.db)
    return store.save(day=day, text=text, sources=facts.sources)
