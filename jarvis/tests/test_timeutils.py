"""Tests de resolution des expressions temporelles."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from jarvis_core.errors import ConfigurationError
from jarvis_core.timeutils import format_datetime_fr, get_tz, resolve_date_expression

TZ = "America/Montreal"
# Un jeudi, pour que les calculs de semaine soient verifiables.
REFERENCE = datetime(2026, 8, 20, 14, 30, tzinfo=ZoneInfo(TZ))


@pytest.mark.parametrize(
    ("expression", "expected_date"),
    [
        ("aujourd'hui", "2026-08-20"),
        ("demain", "2026-08-21"),
        ("apres-demain", "2026-08-22"),
        ("hier", "2026-08-19"),
        ("dans 3 jours", "2026-08-23"),
        ("2026-12-25", "2026-12-25"),
    ],
)
def test_simple_expressions(expression: str, expected_date: str) -> None:
    window = resolve_date_expression(expression, TZ, reference=REFERENCE)
    assert window.start.date().isoformat() == expected_date


def test_accents_and_case_are_ignored() -> None:
    window = resolve_date_expression("APRÈS-DEMAIN", TZ, reference=REFERENCE)
    assert window.start.date().isoformat() == "2026-08-22"


def test_next_weekday_skips_to_following_week() -> None:
    # Jeudi 20 aout -> "vendredi" = le 21, "vendredi prochain" = le 28.
    assert (
        resolve_date_expression("vendredi", TZ, reference=REFERENCE).start.date().isoformat()
        == "2026-08-21"
    )
    assert (
        resolve_date_expression("vendredi prochain", TZ, reference=REFERENCE)
        .start.date()
        .isoformat()
        == "2026-08-28"
    )


def test_last_week_is_a_full_week_in_the_past() -> None:
    window = resolve_date_expression("la semaine passee", TZ, reference=REFERENCE)
    assert window.start.date().isoformat() == "2026-08-10"
    assert (window.end - window.start).days == 7


def test_part_of_day_narrows_the_window() -> None:
    window = resolve_date_expression("demain matin", TZ, reference=REFERENCE)
    assert window.start.hour == 5
    assert window.end.hour == 11 or window.end.hour == 12
    assert window.start.date().isoformat() == "2026-08-21"


def test_timezone_is_preserved() -> None:
    window = resolve_date_expression("demain", TZ, reference=REFERENCE)
    assert window.start.tzinfo is not None
    assert str(window.start.tzinfo) == TZ


def test_unknown_expression_raises_instead_of_guessing() -> None:
    with pytest.raises(ValueError):
        resolve_date_expression("un de ces quatre", TZ, reference=REFERENCE)


def test_french_formatting_is_speakable() -> None:
    assert format_datetime_fr(REFERENCE, TZ) == "jeudi 20 aout 2026, 14 h 30"


# --- Base de fuseaux horaires ------------------------------------------------
# Windows n'embarque aucune base IANA: `zoneinfo` se rabat sur le paquet
# `tzdata`. Ces tests verifient que ce chemin de repli fonctionne, et que les
# echecs donnent une consigne exploitable plutot qu'un message vague.


def test_configured_timezone_loads() -> None:
    assert str(get_tz(TZ)) == TZ


def test_timezone_resolves_without_the_system_database() -> None:
    """Reproduit Windows: on coupe la base systeme, seul `tzdata` reste."""
    import zoneinfo

    original = list(zoneinfo.TZPATH)
    zoneinfo.reset_tzpath([])
    zoneinfo.ZoneInfo.clear_cache()
    try:
        assert str(get_tz("America/Montreal")) == "America/Montreal"
        assert str(get_tz("America/Toronto")) == "America/Toronto"
    finally:
        zoneinfo.reset_tzpath(original)
        zoneinfo.ZoneInfo.clear_cache()


def test_missing_database_tells_the_user_to_install_tzdata(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Aucune base disponible: la consigne doit etre 'pip install tzdata'."""
    import zoneinfo

    from jarvis_core import timeutils

    def always_missing(_name: str) -> object:
        raise zoneinfo.ZoneInfoNotFoundError("no tz database")

    monkeypatch.setattr(timeutils, "ZoneInfo", always_missing)
    with pytest.raises(ConfigurationError) as excinfo:
        timeutils.get_tz("America/Montreal")
    assert "pip install tzdata" in excinfo.value.user_message


def test_unknown_timezone_points_at_the_configuration() -> None:
    """La base existe, mais le fuseau demande n'existe pas."""
    with pytest.raises(ConfigurationError) as excinfo:
        get_tz("Mars/Olympus_Mons")
    assert "JARVIS_TIMEZONE" in excinfo.value.user_message
    assert "pip install" not in excinfo.value.user_message
