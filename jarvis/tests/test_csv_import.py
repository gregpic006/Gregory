

# ------------------------------------------------- dates ecrites en toutes lettres
#
# Un rapport Maitre'D ecrit sa date en clair dans l'en-tete — « jeudi 27 aout
# 2026 » — et c'est parfois la seule date du fichier. Ne pas savoir la lire,
# c'est ne pas savoir dater le rapport.


def test_a_french_written_date_is_read() -> None:
    from datetime import date

    from jarvis_core.business.csv_import import parse_day

    assert parse_day("jeudi 27 aout 2026") == date(2026, 8, 27)
    assert parse_day("jeudi 27 août 2026") == date(2026, 8, 27)


def test_a_written_date_is_found_inside_a_report_line() -> None:
    """La date arrive noyee dans une ligne de titre, pas seule."""
    from datetime import date

    from jarvis_core.business.csv_import import parse_day

    assert parse_day("Sommaire quotidien jeudi 27 aout 2026") == date(2026, 8, 27)


def test_an_abbreviated_month_is_read() -> None:
    from datetime import date

    from jarvis_core.business.csv_import import parse_day

    assert parse_day("27 sept. 2026") == date(2026, 9, 27)


def test_an_english_written_date_is_read() -> None:
    """Les exports de caisse melangent souvent les deux langues."""
    from datetime import date

    from jarvis_core.business.csv_import import parse_day

    assert parse_day("August 27, 2026") == date(2026, 8, 27)


def test_the_numeric_form_still_wins() -> None:
    """L'ecriture en toutes lettres est un recours, jamais un raccourci.

    03/04/2026 doit rester le 3 avril (lecture quebecoise), pas etre
    reinterprete par le nouveau chemin.
    """
    from datetime import date

    from jarvis_core.business.csv_import import parse_day

    assert parse_day("03/04/2026") == date(2026, 4, 3)
    assert parse_day("2026-08-27") == date(2026, 8, 27)


def test_a_line_without_a_date_stays_none() -> None:
    """Un libelle ne doit jamais produire une date inventee."""
    from jarvis_core.business.csv_import import parse_day

    assert parse_day("Total des ventes nettes") is None
    assert parse_day("SPECIALITES") is None
    assert parse_day("") is None


def test_an_impossible_written_date_is_refused() -> None:
    """« 32 aout » n'existe pas: mieux vaut rien qu'une date fausse."""
    from jarvis_core.business.csv_import import parse_day

    assert parse_day("32 aout 2026") is None
    assert parse_day("27 brumaire 2026") is None
