"""Donnees business: la couverture, la fraicheur, et l'interdiction d'inventer.

C'est le module ou une erreur coute le plus cher: un chiffre invente sur un
restaurant, et une decision se prend sur du vide. Ces tests verrouillent trois
choses — une absence de donnee n'est jamais un zero, un total partiel est
annonce comme tel, et une donnee perimee le dit.
"""

from __future__ import annotations

from datetime import date

import pytest

from jarvis_core.business import metrics as vocabulary
from jarvis_core.business.csv_import import (
    ImportError_,
    import_csv,
    parse_amount,
    parse_day,
)
from jarvis_core.business.store import (
    CONNECTED,
    NOT_CONNECTED,
    STALE,
    BusinessStore,
    Fact,
    day_range,
)
from jarvis_core.persistence.db import Database

TODAY = date(2026, 8, 22)


@pytest.fixture
def store() -> BusinessStore:
    db = Database(":memory:")
    db.migrate()
    return BusinessStore(db)


def _seed_week(store: BusinessStore, days: int = 4) -> None:
    """Enregistre `days` jours de ventes finissant le 22 aout."""
    facts = []
    for offset in range(days):
        day = date(2026, 8, 22 - offset).isoformat()
        facts.append(Fact("RESTAURANT_GA", "sales", day, 6000.0, source="csv"))
        facts.append(Fact("RESTAURANT_GA", "labour_cost", day, 1800.0, source="csv"))
    store.record(facts)


# =============================================================================
# Ne jamais inventer
# =============================================================================


def test_absent_metric_is_not_connected_never_zero(store: BusinessStore) -> None:
    """Zero vente et pas de donnee sont deux faits differents."""
    start, end = day_range(7, end=TODAY)

    reading = store.read(
        org_id="RESTAURANT_GA", metric="sales", start=start, end=end, today=TODAY
    )

    assert reading.value is None
    assert reading.status == NOT_CONNECTED
    assert reading.formatted() is None


def test_a_real_zero_is_kept_as_a_value(store: BusinessStore) -> None:
    """Un lundi ferme a zero vente est une donnee, pas une absence."""
    store.record([Fact("RESTAURANT_GA", "sales", "2026-08-22", 0.0, source="csv")])

    reading = store.read(
        org_id="RESTAURANT_GA",
        metric="sales",
        start=date(2026, 8, 22),
        end=TODAY,
        today=TODAY,
    )

    assert reading.value == 0.0
    assert reading.status == CONNECTED


def test_unknown_metric_is_refused_not_answered_with_nothing(store: BusinessStore) -> None:
    reading = store.read(
        org_id="RESTAURANT_GA",
        metric="marge_nette",
        start=date(2026, 8, 1),
        end=TODAY,
        today=TODAY,
    )

    assert reading.status == NOT_CONNECTED
    assert "inconnu" in reading.detail.lower()


def test_never_connected_differs_from_nothing_this_period(store: BusinessStore) -> None:
    """« Jamais branche » et « rien cette semaine » n'appellent pas la meme action."""
    store.record([Fact("RESTAURANT_GA", "sales", "2026-01-05", 5000.0, source="csv")])

    this_week = store.read(
        org_id="RESTAURANT_GA",
        metric="sales",
        start=date(2026, 8, 16),
        end=TODAY,
        today=TODAY,
    )
    never = store.read(
        org_id="RESTAURANT_GA",
        metric="covers",
        start=date(2026, 8, 16),
        end=TODAY,
        today=TODAY,
    )

    assert "cette periode" in this_week.detail
    assert "Aucune source branchee" in never.detail


# =============================================================================
# Couverture
# =============================================================================


def test_partial_period_reports_its_real_coverage(store: BusinessStore) -> None:
    """4 jours sur 7 ne doit jamais se lire comme un total de semaine."""
    _seed_week(store, days=4)
    start, end = day_range(7, end=TODAY)

    reading = store.read(
        org_id="RESTAURANT_GA", metric="sales", start=start, end=end, today=TODAY
    )

    assert reading.value == 24000.0
    assert reading.days_covered == 4
    assert reading.days_requested == 7
    assert reading.complete is False
    assert "4 jour(s) sur 7" in reading.detail


def test_full_period_is_marked_complete(store: BusinessStore) -> None:
    _seed_week(store, days=7)
    start, end = day_range(7, end=TODAY)

    reading = store.read(
        org_id="RESTAURANT_GA", metric="sales", start=start, end=end, today=TODAY
    )

    assert reading.complete is True
    assert reading.detail == ""


def test_stale_data_is_flagged_with_its_age(store: BusinessStore) -> None:
    _seed_week(store, days=2)
    later = date(2026, 9, 15)

    reading = store.read(
        org_id="RESTAURANT_GA",
        metric="sales",
        start=date(2026, 8, 1),
        end=later,
        today=later,
    )

    assert reading.status == STALE
    assert "24 jours" in reading.detail


# =============================================================================
# Agregation
# =============================================================================


def test_rates_are_averaged_not_summed(store: BusinessStore) -> None:
    """Additionner un taux d'occupation donnerait 280 % sur quatre jours."""
    store.record(
        [
            Fact("REAL_ESTATE", "occupancy", f"2026-08-{19 + i}", 70.0, source="csv")
            for i in range(4)
        ]
    )

    reading = store.read(
        org_id="REAL_ESTATE",
        metric="occupancy",
        start=date(2026, 8, 19),
        end=TODAY,
        today=TODAY,
    )

    assert reading.value == 70.0


def test_stock_metrics_take_the_latest_value(store: BusinessStore) -> None:
    """Le MRR n'est pas un cumul: c'est un etat."""
    store.record(
        [
            Fact("PORTAIL", "mrr", "2026-08-20", 41000.0, source="stripe"),
            Fact("PORTAIL", "mrr", "2026-08-22", 42500.0, source="stripe"),
        ]
    )

    reading = store.read(
        org_id="PORTAIL", metric="mrr", start=date(2026, 8, 1), end=TODAY, today=TODAY
    )

    assert reading.value == 42500.0


def test_labour_ratio_refuses_to_compute_on_half_the_data() -> None:
    assert vocabulary.derived_labour_ratio(10000.0, 2900.0) == 29.0
    assert vocabulary.derived_labour_ratio(10000.0, None) is None
    assert vocabulary.derived_labour_ratio(0.0, 2900.0) is None


# =============================================================================
# Idempotence
# =============================================================================


def test_reimporting_the_same_day_replaces_it(store: BusinessStore) -> None:
    """Sans cela, reimporter un fichier doublerait les ventes."""
    store.record([Fact("RESTAURANT_GA", "sales", "2026-08-22", 6000.0, source="csv")])
    store.record([Fact("RESTAURANT_GA", "sales", "2026-08-22", 6500.0, source="csv")])

    reading = store.read(
        org_id="RESTAURANT_GA",
        metric="sales",
        start=date(2026, 8, 22),
        end=TODAY,
        today=TODAY,
    )

    assert reading.value == 6500.0
    assert reading.days_covered == 1


def test_two_sources_for_the_same_day_coexist(store: BusinessStore) -> None:
    """Caisse et Stripe peuvent tous deux rapporter un chiffre: on garde les deux."""
    store.record(
        [
            Fact("PORTAIL", "mrr", "2026-08-22", 42000.0, source="stripe"),
            Fact("PORTAIL", "mrr", "2026-08-22", 41000.0, source="csv"),
        ]
    )

    rows = store.series(
        org_id="PORTAIL", metric="mrr", start="2026-08-22", end="2026-08-22"
    )

    assert len(rows) == 2
    assert {source for _, _, source in rows} == {"stripe", "csv"}


# =============================================================================
# Lecture des fichiers quebecois
# =============================================================================


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1 234,56", 1234.56),  # espace insecable + virgule decimale
        ("1 234,56", 1234.56),
        ("1,234.56", 1234.56),  # format anglais
        ("4 200 $", 4200.0),
        ("(150)", -150.0),  # comptabilite: parentheses = negatif
        ("12,5", 12.5),
        ("1,234", 1234.0),  # trois chiffres apres la virgule = milliers
        ("94,2 %", 94.2),
    ],
)
def test_amounts_parse_in_both_conventions(raw: str, expected: float) -> None:
    assert parse_amount(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "abc", "n/a", "-"])
def test_unreadable_amount_is_none_never_zero(raw: str) -> None:
    """Retourner 0 ferait passer une case vide pour une journee sans vente."""
    assert parse_amount(raw) is None


def test_dates_are_read_the_quebec_way() -> None:
    assert parse_day("20/08/2026") == date(2026, 8, 20)
    assert parse_day("03/04/2026") == date(2026, 4, 3), "JJ/MM, pas MM/JJ"
    assert parse_day("2026-08-20") == date(2026, 8, 20)


@pytest.mark.parametrize("raw", ["32/01/2026", "hier", "", "2026-13-01"])
def test_ambiguous_or_invalid_date_is_refused(raw: str) -> None:
    assert parse_day(raw) is None


# =============================================================================
# Import CSV
# =============================================================================


CSV_QUEBEC = """Date;Ventes;Couverts;Masse salariale;Pourboires
18/08/2026;6 200,50;142;1 890,00;980,00
19/08/2026;5 810,25;131;1 750,00;910,00
oups;5 000,00;100;1 500,00;
21/08/2026;pas ouvert;;;
"""


def test_import_reads_a_semicolon_french_export(store: BusinessStore) -> None:
    report = import_csv(store, CSV_QUEBEC, org_id="RESTAURANT_GA", source_ref="ventes.csv")

    assert report.rows_ok == 2
    assert report.facts == 6
    assert sorted(report.metrics) == ["covers", "labour_cost", "sales"]
    assert report.first_day == "2026-08-18"


def test_every_rejected_line_is_named_with_its_reason(store: BusinessStore) -> None:
    """Un import « reussi » qui saute des lignes produit des totaux faux."""
    report = import_csv(store, CSV_QUEBEC, org_id="RESTAURANT_GA")

    assert report.rows_failed == 2
    lines = {line for line, _ in report.errors}
    assert lines == {4, 5}
    reasons = " ".join(reason for _, reason in report.errors)
    assert "date illisible" in reasons


def test_unknown_columns_are_reported_not_silently_dropped(store: BusinessStore) -> None:
    report = import_csv(store, CSV_QUEBEC, org_id="RESTAURANT_GA")

    assert report.ignored_columns == ["Pourboires"]


def test_file_without_a_date_column_is_refused(store: BusinessStore) -> None:
    with pytest.raises(ImportError_) as excinfo:
        import_csv(store, "Ventes;Couverts\n100;10\n", org_id="RESTAURANT_GA")

    assert "colonne de date" in excinfo.value.user_message


def test_file_without_any_known_metric_is_refused(store: BusinessStore) -> None:
    with pytest.raises(ImportError_) as excinfo:
        import_csv(store, "Date;Meteo\n18/08/2026;pluie\n", org_id="RESTAURANT_GA")

    assert "Aucune colonne reconnue" in excinfo.value.user_message


def test_empty_file_is_refused(store: BusinessStore) -> None:
    with pytest.raises(ImportError_):
        import_csv(store, "   ", org_id="RESTAURANT_GA")


def test_comma_separated_english_export_also_works(store: BusinessStore) -> None:
    content = "Date,Sales,Covers\n2026-08-18,6200.50,142\n2026-08-19,5810.25,131\n"

    report = import_csv(store, content, org_id="RESTAURANT_GA")

    assert report.rows_ok == 2
    reading = store.read(
        org_id="RESTAURANT_GA",
        metric="sales",
        start=date(2026, 8, 18),
        end=date(2026, 8, 19),
        today=date(2026, 8, 19),
    )
    assert reading.value == 12010.75


def test_import_is_logged_for_traceability(store: BusinessStore) -> None:
    import_csv(store, CSV_QUEBEC, org_id="RESTAURANT_GA", source_ref="ventes.csv")

    entries = store.recent_imports(org_id="RESTAURANT_GA")

    assert len(entries) == 1
    assert entries[0]["source_ref"] == "ventes.csv"
    assert entries[0]["rows_ok"] == 2
    assert entries[0]["rows_failed"] == 2


# =============================================================================
# Alias ambigus entre types d'organisation
# =============================================================================


def test_clients_column_means_covers_in_a_restaurant(store: BusinessStore) -> None:
    content = "Date;Ventes;Clients\n18/08/2026;6 200,00;142\n"

    report = import_csv(store, content, org_id="RESTAURANT_GA", kind="restaurant")

    assert "covers" in report.metrics
    assert "customers" not in report.metrics


def test_clients_column_means_accounts_in_a_saas(store: BusinessStore) -> None:
    """« Clients » designe deux choses differentes: le type tranche, pas le hasard."""
    content = "Date;MRR;Clients\n18/08/2026;42 000,00;312\n"

    report = import_csv(store, content, org_id="PORTAIL", kind="saas")

    assert "customers" in report.metrics
    assert "covers" not in report.metrics, "un SaaS n'a pas de couverts"


def test_doors_column_is_saas_units_not_apartments(store: BusinessStore) -> None:
    content = "Date;MRR;Portes\n18/08/2026;42 000,00;1180\n"

    report = import_csv(store, content, org_id="PORTAIL", kind="saas")

    assert "doors" in report.metrics
    assert "units" not in report.metrics


def test_a_restaurant_column_is_ignored_for_a_saas(store: BusinessStore) -> None:
    """Une colonne « Couverts » dans un export SaaS est une erreur, pas une donnee."""
    content = "Date;MRR;Couverts\n18/08/2026;42 000,00;142\n"

    report = import_csv(store, content, org_id="PORTAIL", kind="saas")

    assert report.metrics == ["mrr"]
    assert "Couverts" in report.ignored_columns


def test_without_a_kind_all_metrics_stay_candidates(store: BusinessStore) -> None:
    """Retrocompatible: sans type precise, on ne restreint rien."""
    content = "Date;Ventes\n18/08/2026;6 200,00\n"

    report = import_csv(store, content, org_id="RESTAURANT_GA")

    assert report.metrics == ["sales"]
