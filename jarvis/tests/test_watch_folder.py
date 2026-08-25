"""Import automatique depuis un dossier surveille.

C'est la voie « temps reel » qui ne depend d'aucun fournisseur: la caisse
depose un export, JARVIS l'importe. Ce que ces tests protegent, c'est qu'un
fichier ne soit ni importe deux fois, ni lu pendant son ecriture, ni ignore en
silence.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from jarvis_core.business.store import BusinessStore
from jarvis_core.business.watch_folder import ensure_layout, scan_folder
from jarvis_core.persistence.db import Database

CSV = (
    "Date;Ventes;Couverts\n"
    "19/08/2026;6180,50;142\n"
    "20/08/2026;5920,25;131\n"
)


@pytest.fixture
def store() -> BusinessStore:
    db = Database(":memory:")
    db.migrate()
    return BusinessStore(db)


def _settled(path: Path, content: str = CSV) -> Path:
    """Ecrit un fichier et le fait passer pour ancien: ecriture terminee."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    old = time.time() - 60
    os.utime(path, (old, old))
    return path


def test_a_dropped_file_is_imported(store: BusinessStore, tmp_path: Path) -> None:
    _settled(tmp_path / "RESTAURANT_GA" / "ventes.csv")

    report = scan_folder(store, tmp_path)

    assert report.imported == ["ventes.csv"]
    assert report.rows == 2


def test_the_same_file_is_not_imported_twice(store: BusinessStore, tmp_path: Path) -> None:
    """Sans cela, chaque passage doublerait les ventes."""
    _settled(tmp_path / "RESTAURANT_GA" / "ventes.csv")

    scan_folder(store, tmp_path)
    second = scan_folder(store, tmp_path)

    assert second.imported == []
    assert second.unchanged == ["ventes.csv"]


def test_the_same_name_with_new_content_is_reimported(
    store: BusinessStore, tmp_path: Path
) -> None:
    """Une caisse qui reecrit « ventes.csv » chaque nuit doit etre relue."""
    target = _settled(tmp_path / "RESTAURANT_GA" / "ventes.csv")
    scan_folder(store, tmp_path)

    _settled(target, CSV.replace("6180,50", "9999,99"))
    second = scan_folder(store, tmp_path)

    assert second.imported == ["ventes.csv"]


def test_a_file_being_written_is_left_alone(store: BusinessStore, tmp_path: Path) -> None:
    """Le lire maintenant importerait la moitie d'un export."""
    path = tmp_path / "RESTAURANT_GA" / "ventes.csv"
    path.parent.mkdir(parents=True)
    path.write_text(CSV, encoding="utf-8")  # mtime = maintenant

    report = scan_folder(store, tmp_path)

    assert report.imported == []
    assert [reason for _, reason in report.skipped] == ["ecriture en cours"]


def test_an_unknown_folder_is_named_not_ignored(store: BusinessStore, tmp_path: Path) -> None:
    (tmp_path / "PAS_UNE_ENTREPRISE").mkdir()

    report = scan_folder(store, tmp_path)

    assert report.skipped == [
        ("PAS_UNE_ENTREPRISE", "aucune entreprise ne porte cet identifiant")
    ]


def test_an_unreadable_file_is_reported(store: BusinessStore, tmp_path: Path) -> None:
    _settled(tmp_path / "RESTAURANT_GA" / "meteo.csv", "Date;Meteo\n19/08/2026;pluie\n")

    report = scan_folder(store, tmp_path)

    assert report.imported == []
    assert report.failed and "Aucune colonne reconnue" in report.failed[0][1]


def test_a_wrong_extension_is_skipped(store: BusinessStore, tmp_path: Path) -> None:
    _settled(tmp_path / "RESTAURANT_GA" / "rapport.pdf", "pas du csv")

    report = scan_folder(store, tmp_path)

    assert [name for name, _ in report.skipped] == ["rapport.pdf"]


def test_an_archived_organization_is_not_watched(store: BusinessStore, tmp_path: Path) -> None:
    """Une entreprise retiree ne doit plus rien absorber."""
    store.db.execute("UPDATE organizations SET archived = 1 WHERE id = 'RESTAURANT_GA'")
    _settled(tmp_path / "RESTAURANT_GA" / "ventes.csv")

    report = scan_folder(store, tmp_path)

    assert report.imported == []


def test_a_missing_folder_is_not_an_error(store: BusinessStore, tmp_path: Path) -> None:
    report = scan_folder(store, tmp_path / "absent")

    assert report.imported == []
    assert report.failed == []


def test_layout_creates_one_folder_per_organization(tmp_path: Path) -> None:
    created = ensure_layout(tmp_path / "business", ["RESTAURANT_GA", "PORTAIL"])

    assert {p.name for p in created} == {"RESTAURANT_GA", "PORTAIL"}
    # Idempotent: un second appel ne recree rien.
    assert ensure_layout(tmp_path / "business", ["RESTAURANT_GA", "PORTAIL"]) == []


def test_the_shipped_templates_are_accepted(store: BusinessStore, tmp_path: Path) -> None:
    """Le modele fourni doit passer sans une seule ligne refusee."""
    template = Path("ui/public/modele-restaurant.csv")
    if not template.exists():  # pragma: no cover - depend de l'arborescence
        pytest.skip("modele absent")

    _settled(
        tmp_path / "RESTAURANT_GA" / "modele.csv",
        template.read_text(encoding="utf-8-sig"),
    )
    report = scan_folder(store, tmp_path)

    assert report.imported == ["modele.csv"]
    assert report.failed == []
