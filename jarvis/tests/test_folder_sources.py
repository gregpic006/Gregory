"""Dossiers designes un a un: pointer directement l'export d'une caisse.

La convention « un sous-dossier par entreprise » suppose que l'utilisateur
range les fichiers. La source la plus interessante est le dossier d'export de
la caisse elle-meme — souvent un partage reseau sur un serveur de production —
dont l'organisation ne nous appartient pas.

Le test le plus important de ce fichier est celui qui verifie qu'on ne touche
a rien.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from jarvis_core.business.store import BusinessStore
from jarvis_core.business.watch_folder import (
    FolderSourceStore,
    scan_mapped_folder,
    scan_sources,
)
from jarvis_core.persistence.db import Database

VENTES = "date,ventes,couverts\n2026-08-25,2410.75,138\n2026-08-26,3180.20,171\n"
AUTRE = "date,ventes\n2026-08-27,900.00\n"

#: Les fichiers sont dates dans le passe: sans cela, la garde « ecriture en
#: cours » les mettrait tous de cote.
OLD = time.time() - 3600


@pytest.fixture()
def store(tmp_path: Path) -> BusinessStore:
    db = Database(f"sqlite:///{tmp_path}/t.db")
    db.migrate()
    db.execute(
        "INSERT INTO organizations (id, name, kind, position, archived, created_at)"
        " VALUES ('RESTO', 'Le Resto', 'restaurant', 0, 0, '2026-01-01')"
    )
    return BusinessStore(db)


def _write(folder: Path, name: str, content: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text(content, encoding="utf-8")
    import os

    os.utime(path, (OLD, OLD))
    return path


def test_a_caisse_export_folder_is_imported_as_is(store: BusinessStore, tmp_path: Path) -> None:
    """Pas de convention de rangement imposee: le dossier est pris tel quel."""
    export = tmp_path / "MaitreD" / "Rapports"
    _write(export, "ventes_26aout.csv", VENTES)

    report = scan_mapped_folder(store, export, org_id="RESTO")

    assert report.imported == ["ventes_26aout.csv"]
    assert report.rows == 2


def test_nothing_in_the_folder_is_modified(store: BusinessStore, tmp_path: Path) -> None:
    """Le test le plus important: on lit, on ne range pas.

    Ce dossier peut etre celui d'une caisse en production. Un logiciel qui
    deplace, renomme ou efface les fichiers d'un autre est dangereux — et la
    faute serait invisible jusqu'au jour ou un rapport manquerait.
    """
    export = tmp_path / "Rapports"
    first = _write(export, "ventes.csv", VENTES)
    second = _write(export, "notes.txt", AUTRE)
    before = {p.name: (p.read_bytes(), p.stat().st_mtime) for p in export.iterdir()}

    scan_mapped_folder(store, export, org_id="RESTO")

    after = {p.name: (p.read_bytes(), p.stat().st_mtime) for p in export.iterdir()}
    assert set(after) == set(before), "un fichier a ete ajoute ou retire"
    for name, (content, mtime) in before.items():
        assert after[name][0] == content, f"{name} a ete modifie"
        assert after[name][1] == mtime, f"{name} a ete touche"
    assert first.exists() and second.exists()


def test_the_same_file_is_not_imported_twice(store: BusinessStore, tmp_path: Path) -> None:
    """La caisse reecrit le meme dossier chaque nuit; on repasse chaque heure."""
    export = tmp_path / "Rapports"
    _write(export, "ventes.csv", VENTES)

    first = scan_mapped_folder(store, export, org_id="RESTO")
    second = scan_mapped_folder(store, export, org_id="RESTO")

    assert first.imported and second.imported == []
    assert second.unchanged == ["ventes.csv"]


def test_a_rewritten_file_with_new_content_is_imported(
    store: BusinessStore, tmp_path: Path
) -> None:
    """L'empreinte porte sur le contenu, pas sur le nom.

    Une caisse qui reecrit `ventes.csv` chaque nuit doit etre relue.
    """
    export = tmp_path / "Rapports"
    _write(export, "ventes.csv", VENTES)
    scan_mapped_folder(store, export, org_id="RESTO")

    _write(export, "ventes.csv", AUTRE)
    again = scan_mapped_folder(store, export, org_id="RESTO")

    assert again.imported == ["ventes.csv"]


def test_a_pattern_selects_among_several_reports(
    store: BusinessStore, tmp_path: Path
) -> None:
    """Une caisse depose souvent plusieurs rapports dans le meme dossier."""
    export = tmp_path / "Rapports"
    _write(export, "ventes_26.csv", VENTES)
    _write(export, "inventaire_26.csv", AUTRE)

    report = scan_mapped_folder(store, export, org_id="RESTO", pattern="ventes*.csv")

    assert report.imported == ["ventes_26.csv"]


def test_history_subfolders_are_not_walked(store: BusinessStore, tmp_path: Path) -> None:
    """Une caisse archive des annees a cote: les rejouer serait long et faux."""
    export = tmp_path / "Rapports"
    _write(export, "ventes.csv", VENTES)
    _write(export / "Archives" / "2019", "vieux.csv", AUTRE)

    report = scan_mapped_folder(store, export, org_id="RESTO")

    assert report.imported == ["ventes.csv"]


def test_an_unreachable_share_is_reported_not_silent(
    store: BusinessStore, tmp_path: Path
) -> None:
    """Un partage reseau deconnecte doit se voir.

    Sinon JARVIS afficherait les chiffres d'hier en laissant croire qu'ils
    sont d'aujourd'hui — exactement le mensonge que tout le projet s'interdit.
    """
    report = scan_mapped_folder(store, tmp_path / "PasLa", org_id="RESTO")

    assert report.imported == []
    assert report.failed and "introuvable" in report.failed[0][1]


def test_an_unknown_business_is_refused(store: BusinessStore, tmp_path: Path) -> None:
    export = tmp_path / "Rapports"
    _write(export, "ventes.csv", VENTES)

    report = scan_mapped_folder(store, export, org_id="INEXISTANT")

    assert report.imported == []
    assert report.skipped


# ------------------------------------------------------------ les sources


def test_sources_are_scanned_and_their_state_is_remembered(
    store: BusinessStore, tmp_path: Path
) -> None:
    export = tmp_path / "Rapports"
    _write(export, "ventes.csv", VENTES)
    sources = FolderSourceStore(store.db)
    source = sources.add(org_id="RESTO", path=str(export), label="Maitre'D")

    report = scan_sources(store)

    assert report.imported == ["ventes.csv"]
    after = sources.list_sources()[0]
    assert after.last_run_at and after.last_error == ""
    assert source.id == after.id


def test_a_broken_source_records_its_error(store: BusinessStore, tmp_path: Path) -> None:
    """L'interface doit pouvoir dire pourquoi une source ne rapporte rien."""
    sources = FolderSourceStore(store.db)
    sources.add(org_id="RESTO", path=str(tmp_path / "Deconnecte"))

    scan_sources(store)

    assert "introuvable" in sources.list_sources()[0].last_error


def test_one_broken_source_does_not_stop_the_others(
    store: BusinessStore, tmp_path: Path
) -> None:
    """Un partage tombe ne doit pas priver les autres entreprises."""
    good = tmp_path / "Bon"
    _write(good, "ventes.csv", VENTES)
    sources = FolderSourceStore(store.db)
    sources.add(org_id="RESTO", path=str(tmp_path / "Casse"))
    sources.add(org_id="RESTO", path=str(good))

    report = scan_sources(store)

    assert report.imported == ["ventes.csv"]


def test_sources_can_be_listed_and_removed(store: BusinessStore, tmp_path: Path) -> None:
    sources = FolderSourceStore(store.db)
    source = sources.add(org_id="RESTO", path=str(tmp_path))

    assert [s.id for s in sources.list_sources()] == [source.id]
    assert sources.remove(source.id) is True
    assert sources.list_sources() == []
    assert sources.remove(source.id) is False


def test_a_windows_share_path_is_accepted_as_written(
    store: BusinessStore, tmp_path: Path
) -> None:
    """Un chemin UNC doit etre conserve tel quel, sans normalisation hative.

    `\\\\SERVEUR\\Partage` est la forme que Windows donne a l'utilisateur; le
    transformer casserait l'acces sans que personne comprenne pourquoi.
    """
    sources = FolderSourceStore(store.db)
    unc = r"\\SERVEUR-MD\Rapports\Quotidien"
    sources.add(org_id="RESTO", path=unc)

    assert sources.list_sources()[0].path == unc
