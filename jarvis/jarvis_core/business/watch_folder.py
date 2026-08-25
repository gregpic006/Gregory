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
from dataclasses import dataclass, field
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
    known = {
        str(row["id"]): str(row["kind"])
        for row in store.db.query("SELECT id, kind FROM organizations WHERE archived = 0")
    }

    for org_dir in sorted(p for p in folder.iterdir() if p.is_dir()):
        org_id = org_dir.name
        if org_id not in known:
            report.skipped.append((org_id, "aucune entreprise ne porte cet identifiant"))
            continue

        for file in sorted(p for p in org_dir.iterdir() if p.is_file()):
            if file.suffix.lower() not in SUFFIXES:
                report.skipped.append((file.name, f"format non gere ({file.suffix})"))
                continue
            try:
                if moment - file.stat().st_mtime < SETTLE_SECONDS:
                    # Encore en cours d'ecriture: on le reprendra au prochain tour.
                    report.skipped.append((file.name, "ecriture en cours"))
                    continue
                digest = _fingerprint(file)
            except OSError as exc:
                report.failed.append((file.name, str(exc)))
                continue

            if _already_imported(store.db, org_id, digest):
                report.unchanged.append(file.name)
                continue

            try:
                result = import_csv_file(
                    store, file, org_id=org_id, kind=known[org_id], source="dossier"
                )
            except ImportError_ as exc:
                logger.warning("dossier surveille: %s refuse: %s", file.name, exc)
                report.failed.append((file.name, exc.user_message))
                continue

            # L'empreinte est rangee dans le journal d'import: c'est elle qui
            # empeche de reimporter le meme contenu au prochain passage.
            store.log_import(
                org_id=org_id,
                source="dossier",
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

    return report


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
