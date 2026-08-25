"""Outils business: ce que le modele lit reellement.

Un magasin honnete ne sert a rien si le resume passe au modele efface la
nuance. Ces tests verifient le texte lui-meme: c'est lui qui determine ce que
JARVIS dira a voix haute.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

import jarvis_core.tools.builtin  # noqa: F401  (enregistre les outils)
from jarvis_core.business.store import BusinessStore, Fact
from jarvis_core.config import Settings
from jarvis_core.memory.session import SessionMemory
from jarvis_core.persistence.db import Database
from jarvis_core.timeutils import now
from jarvis_core.tools.base import ToolContext
from jarvis_core.tools.registry import registry


@pytest.fixture
def store() -> BusinessStore:
    db = Database(":memory:")
    db.migrate()
    return BusinessStore(db)


def _context(store: BusinessStore | None) -> ToolContext:
    return ToolContext(
        session_id="s",
        settings=Settings(JARVIS_TIMEZONE=TIMEZONE),
        session=SessionMemory("s"),
        business=store,
    )


#: Le fuseau de reference des tests. Il doit etre celui des outils: a 21 h a
#: Montreal, la date UTC a deja bascule au lendemain, et un ensemencement cale
#: sur `date.today()` tomberait a cote de la fenetre lue par l'outil.
TIMEZONE = "America/Toronto"


def _today() -> date:
    return now(TIMEZONE).date()


def _seed(store: BusinessStore, *, days: int, org: str = "RESTAURANT_GA") -> None:
    """Ventes et masse salariale finissant aujourd'hui, pour que rien ne perime."""
    today = _today()
    facts = []
    for offset in range(days):
        day = (today - timedelta(days=offset)).isoformat()
        facts.append(Fact(org, "sales", day, 6000.0, source="csv"))
        facts.append(Fact(org, "labour_cost", day, 1740.0, source="csv"))
    store.record(facts)


async def test_without_a_store_the_tool_refuses_to_answer(store: BusinessStore) -> None:
    result = await registry.execute(
        "get_business_metrics", {"organization": "Grande Allee"}, _context(None)
    )

    assert result.ok is False
    assert "Aucune source de donnees business" in result.summary


async def test_organization_without_data_is_told_plainly(store: BusinessStore) -> None:
    """Pas de chiffre, pas de zero: une phrase qui dit qu'il n'y a rien."""
    result = await registry.execute(
        "get_business_metrics", {"organization": "Maguire"}, _context(store)
    )

    assert result.data["status"] == "not_connected"
    assert "Aucune donnee" in result.summary
    assert "je ne peux rien affirmer" in result.summary
    assert "0" not in result.summary.split("Aucune donnee")[0]


async def test_unknown_organization_lists_the_real_ones(store: BusinessStore) -> None:
    result = await registry.execute(
        "get_business_metrics", {"organization": "Chez Machin"}, _context(store)
    )

    assert result.ok is False
    assert "Grande Allee" in result.summary
    assert "Portail" in result.summary


async def test_partial_coverage_is_written_next_to_the_number(store: BusinessStore) -> None:
    """Le modele doit lire la couverture, sinon il annoncera un total de semaine."""
    _seed(store, days=3)

    result = await registry.execute(
        "get_business_metrics",
        {"organization": "Grande Allee", "period": "7jours"},
        _context(store),
    )

    assert "seulement 3 jour(s) sur 7" in result.summary
    sales = next(m for m in result.data["metrics"] if m["metric"] == "sales")
    assert sales["complete"] is False


async def test_metrics_without_data_are_named_as_missing(store: BusinessStore) -> None:
    _seed(store, days=7)

    result = await registry.execute(
        "get_business_metrics", {"organization": "Grande Allee"}, _context(store)
    )

    assert "Reservations: aucune donnee" in result.summary
    assert "Cout des aliments: aucune donnee" in result.summary


async def test_labour_ratio_is_offered_when_both_inputs_exist(store: BusinessStore) -> None:
    _seed(store, days=7)

    result = await registry.execute(
        "get_business_metrics", {"organization": "Grande Allee"}, _context(store)
    )

    assert "Masse salariale en % des ventes: 29.0 %" in result.summary
    assert result.data["labour_ratio"] == 29.0


async def test_the_source_is_always_stated(store: BusinessStore) -> None:
    _seed(store, days=7)

    result = await registry.execute(
        "get_business_metrics", {"organization": "Grande Allee"}, _context(store)
    )

    assert "Source(s): csv." in result.summary
    assert result.citations


async def test_stale_data_carries_a_warning_into_the_summary(store: BusinessStore) -> None:
    old = (_today() - timedelta(days=30)).isoformat()
    store.record([Fact("RESTAURANT_GA", "sales", old, 6000.0, source="csv")])

    result = await registry.execute(
        "get_business_metrics",
        {"organization": "Grande Allee", "period": "90jours"},
        _context(store),
    )

    assert "ATTENTION" in result.summary
    assert "derniere donnee il y a 30 jours" in result.summary.lower()


async def test_comparison_refuses_when_one_period_is_empty(store: BusinessStore) -> None:
    """Comparer a une periode vide donnerait un ecart de +100 %, faux et alarmant."""
    _seed(store, days=3)

    result = await registry.execute(
        "compare_business_periods",
        {"organization": "Grande Allee", "metric": "sales", "days": 7},
        _context(store),
    )

    assert result.data["status"] == "not_connected"
    assert "ne peux pas comparer" in result.summary


async def test_comparison_flags_unequal_coverage(store: BusinessStore) -> None:
    """14 jours de donnees compares 7 a 7: la seconde moitie est incomplete."""
    _seed(store, days=10)

    result = await registry.execute(
        "compare_business_periods",
        {"organization": "Grande Allee", "metric": "sales", "days": 7},
        _context(store),
    )

    assert result.data["comparable"] is False
    assert "pas la meme couverture" in result.summary


async def test_comparison_is_clean_when_both_periods_are_full(store: BusinessStore) -> None:
    _seed(store, days=14)

    result = await registry.execute(
        "compare_business_periods",
        {"organization": "Grande Allee", "metric": "sales", "days": 7},
        _context(store),
    )

    assert result.data["comparable"] is True
    assert result.data["delta"] == 0.0
    assert "ATTENTION" not in result.summary


async def test_list_sources_says_which_orgs_have_nothing(store: BusinessStore) -> None:
    _seed(store, days=2)

    result = await registry.execute("list_business_sources", {}, _context(store))

    assert "Grande Allee: Ventes, Masse salariale" in result.summary
    assert "Maguire: aucune donnee branchee" in result.summary
    assert "Portail: aucune donnee branchee" in result.summary


async def test_business_tools_are_hidden_without_the_feature_flag() -> None:
    hidden = {t.name for t in registry.available({"business": False})}
    shown = {t.name for t in registry.available({"business": True})}

    assert "get_business_metrics" not in hidden
    assert {"get_business_metrics", "compare_business_periods"} <= shown


async def test_the_metric_vocabulary_is_closed() -> None:
    """Le modele ne peut pas demander « la marge nette » et recevoir un silence."""
    tool = registry.get("compare_business_periods")
    allowed = tool.schema["properties"]["metric"]["enum"]

    assert "sales" in allowed
    assert "marge_nette" not in allowed
