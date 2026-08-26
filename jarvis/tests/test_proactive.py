"""Surveillance proactive et briefing.

Ce que ces tests protegent: JARVIS ne doit jamais inventer une raison
d'interrompre, ni repeter la meme alerte, ni resumer une source qu'il n'a pas
consultee.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from jarvis_core.briefing import BriefingStore, gather_facts
from jarvis_core.business.store import BusinessStore, Fact
from jarvis_core.config import Settings
from jarvis_core.persistence.db import Database
from jarvis_core.persistence.repositories import ReminderRepository
from jarvis_core.proactive import (
    Alert,
    AlertStore,
    collect_alerts,
    watch_business,
    watch_reminders,
)
from jarvis_core.timeutils import now as now_in

TIMEZONE = "America/Toronto"


def _today() -> date:
    """Date dans le fuseau de l'observateur.

    Semer avec la date UTC decalerait les ages d'un jour le soir, quand
    l'UTC a deja bascule mais pas Quebec.
    """
    return now_in(TIMEZONE).date()


@dataclass
class FakeRuntime:
    """Runtime minimal: chaque source peut etre presente ou absente."""

    db: Database
    settings: Settings
    reminders: Any = None
    business: Any = None
    google: Any = None
    router: Any = None


@pytest.fixture
def db() -> Database:
    database = Database(":memory:")
    database.migrate()
    return database


@pytest.fixture
def runtime(db: Database) -> FakeRuntime:
    return FakeRuntime(db=db, settings=Settings(JARVIS_TIMEZONE=TIMEZONE))


# =============================================================================
# Deduplication
# =============================================================================


def test_the_same_alert_is_recorded_only_once(db: Database) -> None:
    """La surveillance tourne toutes les 5 min: sans cela, elle harcelerait."""
    store = AlertStore(db)
    alert = Alert(
        kind="reminder", title="Rappeler le fournisseur", source="Rappels", dedup_key="r:1"
    )

    first = store.record([alert])
    second = store.record([alert])

    assert len(first) == 1
    assert second == []
    assert len(store.active()) == 1


def test_a_different_alert_is_recorded(db: Database) -> None:
    store = AlertStore(db)

    store.record([Alert(kind="reminder", title="Un", source="Rappels", dedup_key="r:1")])
    fresh = store.record([Alert(kind="reminder", title="Deux", source="Rappels", dedup_key="r:2")])

    assert len(fresh) == 1
    assert len(store.active()) == 2


def test_an_expired_alert_disappears(db: Database) -> None:
    store = AlertStore(db)
    store.record([Alert(kind="info", title="Vieille", source="X", dedup_key="k", ttl_hours=0)])

    assert store.active() == []
    assert store.purge_expired() == 1


def test_marking_seen_then_missing_alert(db: Database) -> None:
    store = AlertStore(db)
    recorded = store.record([Alert(kind="x", title="T", source="S", dedup_key="k")])

    assert store.mark_seen(recorded[0]["id"]) is True
    assert store.active()[0]["seen"] is True
    assert store.mark_seen("al_inexistant") is False


# =============================================================================
# Ne jamais inventer une raison d'interrompre
# =============================================================================


def test_no_calendar_produces_no_alert(runtime: FakeRuntime) -> None:
    """Sans calendrier branche, le silence est la bonne reponse."""
    import asyncio

    from jarvis_core.proactive import watch_calendar

    assert asyncio.run(watch_calendar(runtime)) == []


def test_business_never_connected_is_not_an_alert(runtime: FakeRuntime) -> None:
    """Une organisation jamais branchee est l'etat normal, pas une nouvelle."""
    runtime.business = BusinessStore(runtime.db)

    assert watch_business(runtime) == []


def test_business_that_went_quiet_is_an_alert(runtime: FakeRuntime) -> None:
    """Des donnees qui s'arretent, en revanche, meritent d'etre signalees."""
    store = BusinessStore(runtime.db)
    runtime.business = store
    old_day = (_today() - timedelta(days=20)).isoformat()
    store.record([Fact("RESTAURANT_GA", "sales", old_day, 6000.0, source="csv")])

    alerts = watch_business(runtime)

    assert len(alerts) == 1
    assert "Grande Allee" in alerts[0].title
    assert "20 jours" in alerts[0].title


def test_recent_business_data_is_not_an_alert(runtime: FakeRuntime) -> None:
    store = BusinessStore(runtime.db)
    runtime.business = store
    store.record([Fact("RESTAURANT_GA", "sales", _today().isoformat(), 6000.0, source="csv")])

    assert watch_business(runtime) == []


def test_reminders_due_become_alerts(runtime: FakeRuntime) -> None:
    reminders = ReminderRepository(runtime.db)
    runtime.reminders = reminders
    past = (datetime.now(UTC) - timedelta(hours=2)).isoformat()
    reminders.create(text="Rappeler le fournisseur", due_at=past, due_label="il y a 2 h")

    alerts = watch_reminders(runtime)

    assert len(alerts) == 1
    assert alerts[0].title == "Rappeler le fournisseur"


def test_a_future_reminder_is_not_an_alert(runtime: FakeRuntime) -> None:
    reminders = ReminderRepository(runtime.db)
    runtime.reminders = reminders
    future = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    reminders.create(text="Plus tard", due_at=future)

    assert watch_reminders(runtime) == []


def test_a_reminder_stored_in_utc_is_compared_correctly(runtime: FakeRuntime) -> None:
    """Comparer « ...+00:00 » et « ...-04:00 » comme des chaines donne le desordre.

    Un rappel echu passerait pour a venir simplement parce que « 13 » est
    superieur a « 09 » dans l'ordre alphabetique.
    """
    reminders = ReminderRepository(runtime.db)
    runtime.reminders = reminders
    # Echeance en UTC, il y a une heure. L'heure locale de Quebec a ce moment
    # s'ecrit avec un chiffre des heures plus petit.
    past_utc = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    reminders.create(text="Echu", due_at=past_utc)

    assert len(watch_reminders(runtime)) == 1


async def test_collect_survives_a_broken_watcher(runtime: FakeRuntime) -> None:
    """Un observateur casse ne doit pas priver des autres."""

    class ExplodingReminders:
        def due_before(self, _: str) -> list[Any]:
            raise RuntimeError("base corrompue")

    runtime.reminders = ExplodingReminders()
    store = BusinessStore(runtime.db)
    runtime.business = store
    old_day = (_today() - timedelta(days=30)).isoformat()
    store.record([Fact("PORTAIL", "mrr", old_day, 42000.0, source="csv")])

    alerts = await collect_alerts(runtime)

    assert [a.kind for a in alerts] == ["business"]


# =============================================================================
# Briefing
# =============================================================================


async def test_briefing_names_the_sources_it_could_not_reach(runtime: FakeRuntime) -> None:
    """« Non consulte » n'est pas la meme chose que « rien a signaler »."""
    facts = await gather_facts(runtime)

    assert "agenda (non connecte)" in facts.unavailable
    assert "courriels (non connecte)" in facts.unavailable
    assert "Google Calendar" not in facts.sources


async def test_briefing_lists_only_real_sources(runtime: FakeRuntime) -> None:
    runtime.reminders = ReminderRepository(runtime.db)

    facts = await gather_facts(runtime)

    assert facts.sources == ["Rappels"]


async def test_briefing_without_any_source_says_so(runtime: FakeRuntime) -> None:
    facts = await gather_facts(runtime)
    text = facts.as_plain_text("Greg")

    assert "Non consulte" in text
    # Aucun contenu invente pour combler le vide.
    assert "rendez-vous" not in text.lower()


async def test_briefing_prompt_forbids_invention(runtime: FakeRuntime) -> None:
    """Le prompt doit interdire explicitement d'ajouter des faits."""
    from jarvis_core.briefing import SYSTEM_PROMPT

    assert "REGLE ABSOLUE" in SYSTEM_PROMPT
    assert "n'invente jamais" in SYSTEM_PROMPT


def test_briefing_store_keeps_one_entry_per_day(db: Database) -> None:
    store = BriefingStore(db)

    store.save(day="2026-08-25", text="Premiere version", sources=["Rappels"])
    store.save(day="2026-08-25", text="Version corrigee", sources=["Rappels", "Gmail"])

    latest = store.latest()
    assert latest is not None
    assert latest["text"] == "Version corrigee"
    assert latest["sources"] == ["Rappels", "Gmail"]


def test_briefing_store_is_empty_before_the_first_run(db: Database) -> None:
    assert BriefingStore(db).latest() is None
