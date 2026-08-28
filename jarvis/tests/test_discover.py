"""Trouver les dossiers de rapports a la place de l'utilisateur.

« Colle le chemin du dossier » suppose qu'on sache ou son logiciel de caisse
ecrit. Presque personne ne le sait — et c'est la raison pour laquelle rien
n'etait branche.

Le critere n'est pas un nom de dossier mais « JARVIS sait-il lire ce
fichier ? », teste avec la meme fonction que l'import reel. Ces tests
verrouillent ce critere et les bornes de la recherche.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from jarvis_core.business.discover import IGNORED, discover

RAPPORT = (
    "Rapport des ventes\nGenere le 2026-08-26\n\n"
    "Date;Ventes;Couverts\n2026-08-25;2410,75;138\n"
)
CARNET = "Nom,Adresse\nJean,123 rue Principale\n"


def _write(folder: Path, name: str, content: str, encoding: str = "utf-8") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text(content, encoding=encoding)
    return path


def test_a_report_folder_is_found_however_it_is_named(tmp_path: Path) -> None:
    """« Rapports », « Reports », « Sorties »: le nom ne decide de rien."""
    caisse = tmp_path / "SERVEUR" / "MaitreD" / "BackOffice" / "Sorties"
    _write(caisse, "SLS_20260826.csv", RAPPORT, encoding="cp1252")

    report = discover([tmp_path])

    assert [c.path for c in report.candidates] == [str(caisse)]


def test_the_columns_that_will_be_read_are_shown(tmp_path: Path) -> None:
    """L'utilisateur doit voir ce que JARVIS y lira avant de l'ajouter."""
    _write(tmp_path / "Export", "ventes.csv", RAPPORT, encoding="cp1252")

    found = discover([tmp_path]).candidates[0]

    assert "Ventes" in found.columns
    assert "Couverts" in found.columns


def test_a_csv_that_is_not_a_report_is_not_proposed(tmp_path: Path) -> None:
    """Un carnet d'adresses est un CSV, pas un rapport de ventes.

    Proposer tout fichier .csv noierait le vrai dossier sous des leurres.
    """
    _write(tmp_path / "Compta", "clients.csv", CARNET)

    assert discover([tmp_path]).candidates == []


def test_system_folders_are_never_walked(tmp_path: Path) -> None:
    """Ils n'ont jamais contenu de rapport, et les parcourir coute cher."""
    for name in ("Windows", "node_modules", "AppData"):
        assert name.lower() in IGNORED
        _write(tmp_path / name / "Sub", "ventes.csv", RAPPORT, encoding="cp1252")

    assert discover([tmp_path]).candidates == []


def test_hidden_folders_are_skipped(tmp_path: Path) -> None:
    _write(tmp_path / ".cache" / "x", "ventes.csv", RAPPORT, encoding="cp1252")

    assert discover([tmp_path]).candidates == []


def test_nothing_found_is_said_plainly(tmp_path: Path) -> None:
    """Un resultat vide doit expliquer quoi faire, pas rester muet."""
    report = discover([tmp_path])

    assert report.candidates == []
    assert "lecteur reseau" in report.summary()


def test_the_search_stops_at_its_depth_limit(tmp_path: Path) -> None:
    """Un disque profond ne doit pas figer l'interface."""
    deep = tmp_path
    for level in range(8):
        deep = deep / f"n{level}"
    _write(deep, "ventes.csv", RAPPORT, encoding="cp1252")

    assert discover([tmp_path], max_depth=3).candidates == []
    assert discover([tmp_path], max_depth=9).candidates != []


def test_the_search_stops_at_its_directory_limit(tmp_path: Path) -> None:
    for index in range(40):
        (tmp_path / f"d{index}").mkdir()

    report = discover([tmp_path], max_directories=5)

    assert report.scanned <= 5
    assert report.truncated is True


def test_an_unreadable_folder_does_not_stop_the_search(tmp_path: Path) -> None:
    """Un dossier protege ou un partage deconnecte se saute en silence."""
    blocked = tmp_path / "protege"
    blocked.mkdir()
    good = tmp_path / "Export"
    _write(good, "ventes.csv", RAPPORT, encoding="cp1252")
    os.chmod(blocked, 0o000)
    try:
        report = discover([tmp_path])
        assert [c.path for c in report.candidates] == [str(good)]
    finally:
        os.chmod(blocked, 0o755)


def test_nothing_is_written_while_searching(tmp_path: Path) -> None:
    """La recherche parcourt un disque de production: elle lit, point."""
    caisse = tmp_path / "Export"
    _write(caisse, "ventes.csv", RAPPORT, encoding="cp1252")
    before = {
        p.name: (p.read_bytes(), p.stat().st_mtime)
        for p in tmp_path.rglob("*")
        if p.is_file()
    }

    discover([tmp_path])

    after = {
        p.name: (p.read_bytes(), p.stat().st_mtime)
        for p in tmp_path.rglob("*")
        if p.is_file()
    }
    assert after == before


def test_only_the_head_of_a_file_is_read(tmp_path: Path) -> None:
    """Un export d'un an ne doit pas etre charge pour etre reconnu."""
    huge = RAPPORT + "\n".join(f"2026-01-{d:02d};10,00;5" for d in range(1, 29)) * 4000
    path = _write(tmp_path / "Export", "gros.csv", huge, encoding="cp1252")
    assert path.stat().st_size > 1_000_000

    started = time.monotonic()
    report = discover([tmp_path])

    assert report.candidates
    # Lire un megaoctet prendrait bien plus que ca sur n'importe quel disque.
    assert time.monotonic() - started < 2.0
