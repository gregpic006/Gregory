"""Import automatique depuis un dossier surveille.

C'est la reponse la plus solide a « je veux mes chiffres en temps reel » sans
dependre d'un fournisseur.  Toutes les caisses savent deposer un export a heure
fixe dans un dossier — beaucoup le font deja pour la comptabilite.  JARVIS
regarde ce dossier et importe ce qui arrive.

Aucune entente d'integration, aucune cle d'API, aucun service tiers entre les
donnees et la machine.

Convention: un sous-dossier par entreprise, nomme d'apres son identifiant.

    data/business/
      RESTAURANT_GA/ventes-2026-08-25.csv
      PORTAIL/mrr-2026-08-25.csv

Trois precautions.

**Un fichier deja importe ne l'est pas deux fois.**  On retient son empreinte,
pas son nom: une caisse qui reecrit le meme nom chaque nuit avec un contenu
different doit etre reimportee, et un fichier simplement renomme ne doit pas
l'etre.

**Un fichier en cours d'ecriture n'est pas lu.**  On saute ceux modifies dans
les dernieres secondes, sinon on importerait la moitie d'un export.

**Un fichier illisible est signale, pas efface.**  Il reste sur place et son
erreur est nommee.
"""

from __future__ import annotations

import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

from jarvis_core.business.csv_import import ImportError_, import_csv_file
from jarvis_core.business.store import BusinessStore
from jarvis_core.persistence.db import Database

logger = logging.getLogger(__name__)

#: Un fichier touche il y a moins de ca est probablement encore en cours
#: d'ecriture par la caisse.
SETTLE_SECONDS = 10.0

SUFFIXES = frozenset({".csv", ".txt"})


@dataclass
class WatchReport:
    """Ce qu'un passage de surveillance a fait."""

    imported: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    rows: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.imported)

    def summary(self) -> str:
        parts = []
        if self.imported:
            parts.append(f"{len(self.imported)} fichier(s) importe(s)")
        if self.unchanged:
            parts.append(f"{len(self.unchanged)} inchange(s)")
        if self.failed:
            parts.append(f"{len(self.failed)} en echec")
        return ", ".join(parts) if parts else "rien de nouveau"

    def as_dict(self) -> dict[str, Any]:
        return {
            "imported": self.imported,
            "unchanged": self.unchanged,
            "skipped": [{"name": n, "reason": r} for n, r in self.skipped],
            "failed": [{"name": n, "reason": r} for n, r in self.failed],
            "rows": self.rows,
            "summary": self.summary(),
        }


def _fingerprint(path: Path) -> str:
    """Empreinte du contenu, pas du nom.

    Une caisse qui reecrit `ventes.csv` chaque nuit doit etre reimportee; un
    fichier renomme sans changement ne doit pas l'etre.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _already_imported(db: Database, org_id: str, digest: str) -> bool:
    row = db.query_one(
        "SELECT id FROM business_imports WHERE org_id = ? AND detail LIKE ? LIMIT 1",
        (org_id, f"%{digest[:16]}%"),
    )
    return row is not None


def _import_file(
    store: BusinessStore,
    file: Path,
    *,
    org_id: str,
    kind: str,
    moment: float,
    report: WatchReport,
    source: str,
) -> None:
    """Importe un fichier s'il est nouveau, complet et lisible.

    **Ne modifie jamais le fichier.** Il est lu, jamais deplace, renomme ni
    efface — un dossier surveille peut etre celui d'une caisse en production,
    et un logiciel qui range les fichiers d'un autre est un logiciel dangereux.
    """
    if file.suffix.lower() not in SUFFIXES:
        report.skipped.append((file.name, f"format non gere ({file.suffix})"))
        return
    try:
        if moment - file.stat().st_mtime < SETTLE_SECONDS:
            # Encore en cours d'ecriture: on le reprendra au prochain tour.
            report.skipped.append((file.name, "ecriture en cours"))
            return
        digest = _fingerprint(file)
    except OSError as exc:
        report.failed.append((file.name, str(exc)))
        return

    if _already_imported(store.db, org_id, digest):
        report.unchanged.append(file.name)
        return

    try:
        result = import_csv_file(store, file, org_id=org_id, kind=kind, source=source)
    except ImportError_ as exc:
        logger.warning("dossier surveille: %s refuse: %s", file.name, exc)
        report.failed.append((file.name, exc.user_message))
        return

    # L'empreinte est rangee dans le journal d'import: c'est elle qui empeche
    # de reimporter le meme contenu au prochain passage.
    store.log_import(
        org_id=org_id,
        source=source,
        source_ref=file.name,
        rows_ok=result.rows_ok,
        rows_failed=result.rows_failed,
        detail=f"empreinte:{digest[:16]} {result.summary()}",
    )
    report.imported.append(file.name)
    report.rows += result.rows_ok
    if result.rows_failed:
        report.failed.append(
            (file.name, f"{result.rows_failed} ligne(s) refusee(s) dans ce fichier")
        )


def scan_folder(
    store: BusinessStore, root: Path | str, *, now: float | None = None
) -> WatchReport:
    """Importe les fichiers nouveaux du dossier surveille.

    Args:
        root: dossier contenant un sous-dossier par entreprise.
    """
    report = WatchReport()
    folder = Path(root).expanduser()
    if not folder.is_dir():
        return report

    moment = now if now is not None else time.time()
    known = _known_organizations(store)

    for org_dir in sorted(p for p in folder.iterdir() if p.is_dir()):
        org_id = org_dir.name
        if org_id not in known:
            report.skipped.append((org_id, "aucune entreprise ne porte cet identifiant"))
            continue
        for file in sorted(p for p in org_dir.iterdir() if p.is_file()):
            _import_file(
                store,
                file,
                org_id=org_id,
                kind=known[org_id],
                moment=moment,
                report=report,
                source="dossier",
            )

    return report


def scan_mapped_folder(
    store: BusinessStore,
    root: Path | str,
    *,
    org_id: str,
    pattern: str = "",
    now: float | None = None,
    report: WatchReport | None = None,
) -> WatchReport:
    """Importe un dossier quelconque dans une entreprise donnee.

    C'est ce qui permet de pointer **directement** le dossier d'export d'une
    caisse — y compris un partage reseau — au lieu d'exiger qu'il soit range
    selon notre convention. Le logiciel de caisse ecrit ou il veut; c'est a
    nous de nous adapter, pas a l'utilisateur de deplacer des fichiers.

    Args:
        pattern: motif de nom de fichier (« *.csv », « ventes*.csv »). Vide =
            tous les fichiers lisibles. Utile quand un meme dossier contient
            plusieurs rapports differents.
    """
    report = report if report is not None else WatchReport()
    folder = Path(root).expanduser()
    try:
        if not folder.is_dir():
            report.failed.append((str(root), "dossier introuvable ou inaccessible"))
            return report
        # On ne descend pas dans les sous-dossiers: une caisse archive souvent
        # des annees d'historique a cote, et les rejouer serait long et faux.
        entries = sorted(p for p in folder.iterdir() if p.is_file())
    except OSError as exc:
        # Un partage reseau deconnecte leve ici. Ce n'est pas une panne de
        # JARVIS, et ca se dit plutot que de passer sous silence.
        report.failed.append((str(root), f"acces impossible: {exc}"))
        return report

    known = _known_organizations(store)
    if org_id not in known:
        report.skipped.append((org_id, "aucune entreprise ne porte cet identifiant"))
        return report

    moment = now if now is not None else time.time()
    for file in entries:
        if pattern and not fnmatch(file.name.lower(), pattern.lower()):
            continue
        _import_file(
            store,
            file,
            org_id=org_id,
            kind=known[org_id],
            moment=moment,
            report=report,
            source="dossier",
        )
    return report


def _known_organizations(store: BusinessStore) -> dict[str, str]:
    return {
        str(row["id"]): str(row["kind"])
        for row in store.db.query("SELECT id, kind FROM organizations WHERE archived = 0")
    }


def ensure_layout(root: Path | str, org_ids: list[str]) -> list[Path]:
    """Cree le dossier surveille et un sous-dossier par entreprise."""
    folder = Path(root).expanduser()
    folder.mkdir(parents=True, exist_ok=True)
    created: list[Path] = []
    for org_id in org_ids:
        target = folder / org_id
        if not target.exists():
            target.mkdir(parents=True, exist_ok=True)
            created.append(target)
    return created


# ------------------------------------------------- dossiers designes un a un


@dataclass(frozen=True)
class FolderSource:
    """« Tout ce qui arrive dans ce dossier appartient a cette entreprise. »"""

    id: str
    org_id: str
    path: str
    pattern: str = ""
    label: str = ""
    enabled: bool = True
    last_run_at: str = ""
    last_error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "path": self.path,
            "pattern": self.pattern,
            "label": self.label,
            "enabled": self.enabled,
            "last_run_at": self.last_run_at,
            "last_error": self.last_error,
        }


class FolderSourceStore:
    """Les dossiers designes par l'utilisateur."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def add(
        self, *, org_id: str, path: str, pattern: str = "", label: str = ""
    ) -> FolderSource:
        source = FolderSource(
            id=f"fs_{uuid.uuid4().hex[:10]}",
            org_id=org_id,
            path=path.strip(),
            pattern=pattern.strip(),
            label=label.strip(),
        )
        self.db.execute(
            "INSERT INTO business_folder_sources"
            " (id, org_id, path, pattern, label, enabled, created_at)"
            " VALUES (?,?,?,?,?,1,?)",
            (
                source.id,
                source.org_id,
                source.path,
                source.pattern,
                source.label,
                datetime.now(UTC).isoformat(),
            ),
        )
        return source

    def remove(self, source_id: str) -> bool:
        if not self.db.query_one(
            "SELECT id FROM business_folder_sources WHERE id = ?", (source_id,)
        ):
            return False
        self.db.execute("DELETE FROM business_folder_sources WHERE id = ?", (source_id,))
        return True

    def list_sources(self, *, only_enabled: bool = False) -> list[FolderSource]:
        clause = " WHERE enabled = 1" if only_enabled else ""
        rows = self.db.query(
            f"SELECT * FROM business_folder_sources{clause} ORDER BY created_at"
        )
        return [
            FolderSource(
                id=str(row["id"]),
                org_id=str(row["org_id"]),
                path=str(row["path"]),
                pattern=str(row["pattern"]),
                label=str(row["label"]),
                enabled=bool(row["enabled"]),
                last_run_at=str(row["last_run_at"]),
                last_error=str(row["last_error"]),
            )
            for row in rows
        ]

    def mark_run(self, source_id: str, error: str = "") -> None:
        """Retient le dernier passage et son eventuel echec.

        Un partage reseau deconnecte doit se voir dans l'interface: sans cela,
        JARVIS afficherait des chiffres d'hier en laissant croire qu'ils sont
        d'aujourd'hui.
        """
        self.db.execute(
            "UPDATE business_folder_sources SET last_run_at = ?, last_error = ?"
            " WHERE id = ?",
            (datetime.now(UTC).isoformat(), error[:300], source_id),
        )


def scan_sources(store: BusinessStore, *, now: float | None = None) -> WatchReport:
    """Parcourt tous les dossiers designes. Un echec n'arrete pas les autres."""
    report = WatchReport()
    sources = FolderSourceStore(store.db)
    for source in sources.list_sources(only_enabled=True):
        before = len(report.failed)
        scan_mapped_folder(
            store,
            source.path,
            org_id=source.org_id,
            pattern=source.pattern,
            now=now,
            report=report,
        )
        # On ne retient comme erreur de la source que celles qui la concernent:
        # un fichier illisible parmi dix n'est pas une source en panne.
        trouble = ""
        for name, reason in report.failed[before:]:
            if name == source.path:
                trouble = reason
                break
        sources.mark_run(source.id, trouble)
    return report
