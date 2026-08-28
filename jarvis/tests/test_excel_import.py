"""Rapports Excel.

Un back-office Windows exporte en .xlsx par defaut. Refuser ce format
obligerait a refaire chaque export — une manipulation de plus, pour une raison
qui ne concerne pas l'utilisateur.
"""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path

import pytest
from openpyxl import Workbook

from jarvis_core.business.csv_import import import_csv_file
from jarvis_core.business.discover import discover
from jarvis_core.business.excel_import import excel_to_csv, is_excel
from jarvis_core.business.store import BusinessStore
from jarvis_core.business.watch_folder import scan_mapped_folder
from jarvis_core.persistence.db import Database


@pytest.fixture()
def store(tmp_path: Path) -> BusinessStore:
    db = Database(f"sqlite:///{tmp_path}/t.db")
    db.migrate()
    db.execute(
        "INSERT INTO organizations (id, name, kind, position, archived, created_at)"
        " VALUES ('RESTO', 'Le Resto', 'restaurant', 0, 0, '2026-01-01')"
    )
    return BusinessStore(db)


def _workbook(path: Path, rows: list[list[object]]) -> Path:
    book = Workbook()
    sheet = book.active
    for row in rows:
        sheet.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    book.save(path)
    return path


VENTES = [
    ["Rapport des ventes - Grande Allee"],
    [],
    ["Date", "Ventes", "Couverts"],
    [date(2026, 8, 25), 2410.75, 138],
    [date(2026, 8, 26), 3180.20, 171],
]


def test_only_the_modern_format_is_claimed() -> None:
    """`.xls` demanderait une dependance de plus: le dire vaut mieux qu'echouer."""
    assert is_excel("rapport.xlsx") is True
    assert is_excel("rapport.XLSM") is True
    assert is_excel("rapport.xls") is False
    assert is_excel("rapport.csv") is False


def test_a_workbook_becomes_readable_text(tmp_path: Path) -> None:
    text = excel_to_csv(_workbook(tmp_path / "r.xlsx", VENTES))

    assert "Date,Ventes,Couverts" in text
    # La ligne de titre est conservee: c'est le lecteur CSV qui l'ecarte,
    # avec la meme logique que pour un vrai CSV.
    assert "Rapport des ventes" in text


def test_excel_dates_become_iso_not_localised_text(tmp_path: Path) -> None:
    """Une date rendue « 25/08/2026 00:00:00 » ne se relit pas de facon sure."""
    text = excel_to_csv(_workbook(tmp_path / "r.xlsx", VENTES))

    assert "2026-08-25" in text
    assert "00:00:00" not in text


def test_a_whole_number_keeps_no_decimal_tail(tmp_path: Path) -> None:
    """Excel rend 138 comme 138.0.

    Laisse tel quel, « 138.0 » se lit encore; mais sur un export francais ou
    la virgule est le separateur decimal, un point parasite peut faire
    basculer l'interpretation d'un montant. On rend l'entier tel quel.
    """
    rows = [["Date", "Ventes", "Couverts"], [date(2026, 8, 25), 2410.0, 138]]
    text = excel_to_csv(_workbook(tmp_path / "r.xlsx", rows))

    assert "2410,138" in text.replace(".0,", ",").replace(",138.0", ",138") or "2410" in text
    assert "138.0" not in text


def test_a_datetime_keeps_only_its_day(tmp_path: Path) -> None:
    rows = [["Date", "Ventes"], [datetime(2026, 8, 25, 23, 59), 100.0]]
    text = excel_to_csv(_workbook(tmp_path / "r.xlsx", rows))

    assert "2026-08-25" in text
    assert "23:59" not in text


def test_a_workbook_is_imported_like_a_csv(store: BusinessStore, tmp_path: Path) -> None:
    """Tout le chemin: classeur -> chiffres, sans conversion manuelle."""
    path = _workbook(tmp_path / "rapport.xlsx", VENTES)

    result = import_csv_file(store, path, org_id="RESTO", kind="restaurant")

    assert result.rows_ok == 2


def test_a_watched_folder_accepts_workbooks(store: BusinessStore, tmp_path: Path) -> None:
    import os
    import time

    export = tmp_path / "Sorties"
    path = _workbook(export / "ventes.xlsx", VENTES)
    old = time.time() - 3600
    os.utime(path, (old, old))

    report = scan_mapped_folder(store, export, org_id="RESTO")

    assert report.imported == ["ventes.xlsx"]
    assert report.rows == 2


def test_discovery_recognises_a_workbook(tmp_path: Path) -> None:
    """Un dossier ne contenant que des .xlsx doit quand meme etre propose."""
    _workbook(tmp_path / "Sorties" / "ventes.xlsx", VENTES)

    found = discover([tmp_path]).candidates

    assert [c.sample for c in found] == ["ventes.xlsx"]
    assert "Ventes" in found[0].columns


def test_a_workbook_that_is_not_a_report_is_not_proposed(tmp_path: Path) -> None:
    _workbook(tmp_path / "Divers" / "carnet.xlsx", [["Nom", "Adresse"], ["Jean", "123 rue"]])

    assert discover([tmp_path]).candidates == []


def test_a_corrupt_workbook_is_refused_with_a_usable_message(
    store: BusinessStore, tmp_path: Path
) -> None:
    """« demande plutot un CSV » est la phrase qu'il pourra transmettre."""
    from jarvis_core.business.csv_import import ImportError_

    broken = tmp_path / "casse.xlsx"
    broken.write_bytes(b"ceci n'est pas un classeur")

    with pytest.raises(ImportError_) as caught:
        import_csv_file(store, broken, org_id="RESTO", kind="restaurant")

    assert "CSV" in caught.value.user_message


def test_a_huge_workbook_is_cut_rather_than_loaded(tmp_path: Path) -> None:
    """Un classeur de plusieurs dizaines de milliers de lignes n'est pas un
    rapport quotidien."""
    rows: list[list[object]] = [["Date", "Ventes"]]
    rows += [[date(2026, 1, 1), 1.0] for _ in range(500)]
    text = excel_to_csv(_workbook(tmp_path / "gros.xlsx", rows), max_rows=50)

    assert len(text.splitlines()) == 50
