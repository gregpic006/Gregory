"""Trouver tout seul les dossiers de rapports.

Le proprietaire de ce projet peut atteindre le serveur de sa caisse depuis son
ordinateur, mais rien n'est branche — et la raison est simple: **il ne sait pas
quel chemin taper.** Lui demander « colle le chemin du dossier » suppose qu'il
sache ou son logiciel de caisse ecrit. Presque personne ne le sait.

Ce module cherche a sa place.

Le critere de reconnaissance n'est pas un nom de dossier — « Rapports »,
« Reports », « Exports » varient d'une installation a l'autre et d'une langue a
l'autre. C'est **« JARVIS sait-il lire ce fichier ? »**, teste avec la meme
fonction que l'import reel. Un dossier est propose parce que son contenu est
importable, pas parce qu'il porte le bon nom. La proposition est donc vraie par
construction.

Quatre garde-fous, parce que ce module parcourt un disque.

**La recherche est bornee.** Nombre de dossiers, profondeur et duree sont
plafonnes. Un disque de plusieurs teraoctets ne doit pas figer l'interface.

**On ne lit qu'un echantillon.** Quelques kilo-octets en tete de fichier
suffisent a reconnaitre un en-tete; on ne charge jamais un fichier entier.

**On ne touche a rien.** Lecture seule, sans exception.

**Les dossiers systeme sont ignores.** Windows, Program Files, AppData et les
dossiers techniques n'ont jamais contenu de rapport de ventes, et les
parcourir coute cher pour rien.
"""

from __future__ import annotations

import logging
import os
import string
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Bornes de la recherche. Depassees, on rend ce qu'on a trouve.
MAX_DIRECTORIES = 4000
MAX_DEPTH = 5
MAX_SECONDS = 20.0
#: Assez pour reconnaitre un en-tete, meme precede de lignes de titre.
SAMPLE_BYTES = 8192
#: Au-dela, on arrete de proposer: une liste trop longue ne se lit pas.
MAX_CANDIDATES = 12

SUFFIXES = frozenset({".csv", ".txt", ".tsv", ".xlsx", ".xlsm"})

#: Dossiers qui n'ont jamais contenu un rapport de ventes.
IGNORED = frozenset(
    {
        "windows", "program files", "program files (x86)", "programdata",
        "appdata", "$recycle.bin", "system volume information", "recovery",
        "node_modules", ".git", ".venv", "venv", "__pycache__", "site-packages",
        "temp", "tmp", "cache", "caches", "library", "applications",
        ".cache", ".local", ".npm", "proc", "sys", "dev", "snap",
    }
)


@dataclass
class Candidate:
    """Un dossier qui contient des rapports lisibles."""

    path: str
    #: Fichier qui a permis de reconnaitre le dossier.
    sample: str
    #: Colonnes reconnues dans ce fichier: ce que JARVIS y lira.
    columns: list[str] = field(default_factory=list)
    files: int = 0
    #: Date du fichier le plus recent, en clair.
    newest: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "sample": self.sample,
            "columns": self.columns,
            "files": self.files,
            "newest": self.newest,
        }


@dataclass
class DiscoveryReport:
    """Resultat d'une recherche."""

    candidates: list[Candidate] = field(default_factory=list)
    roots: list[str] = field(default_factory=list)
    scanned: int = 0
    #: Vrai si la recherche s'est arretee sur une borne plutot qu'a la fin.
    truncated: bool = False
    seconds: float = 0.0

    def summary(self) -> str:
        if not self.candidates:
            return (
                "Aucun dossier de rapports trouve. Si ta caisse ecrit sur un "
                "lecteur reseau, connecte-le puis relance la recherche."
            )
        count = len(self.candidates)
        return f"{count} dossier(s) contenant des rapports lisibles."

    def as_dict(self) -> dict[str, Any]:
        return {
            "candidates": [c.as_dict() for c in self.candidates],
            "roots": self.roots,
            "scanned": self.scanned,
            "truncated": self.truncated,
            "seconds": round(self.seconds, 1),
            "summary": self.summary(),
        }


def default_roots() -> list[Path]:
    """Endroits ou chercher.

    Sous Windows, toutes les lettres de lecteur existantes — **y compris les
    lecteurs reseau**, qui sont justement le cas interessant: le serveur de la
    caisse est presque toujours monte ainsi.
    """
    roots: list[Path] = []
    if os.name == "nt":  # pragma: no cover - depend du systeme
        for letter in string.ascii_uppercase:
            drive = Path(f"{letter}:/")
            try:
                if drive.exists():
                    roots.append(drive)
            except OSError:
                continue
        return roots

    home = Path.home()
    for candidate in (home, Path("/mnt"), Path("/media"), Path("/Volumes")):
        try:
            if candidate.is_dir():
                roots.append(candidate)
        except OSError:
            continue
    return roots


def _readable_header(path: Path) -> list[str] | None:
    """Colonnes reconnues si ce fichier est un rapport lisible, sinon None.

    Utilise exactement la logique de l'import: un dossier n'est propose que
    si JARVIS saurait vraiment en lire le contenu.
    """


    from jarvis_core.business.excel_import import excel_to_csv, is_excel

    if is_excel(path.name):
        # Un classeur ne se reconnait pas sur ses premiers octets: on le
        # convertit, en se limitant aux premieres lignes.
        try:
            text = excel_to_csv(path, max_rows=30)
        except Exception:  # noqa: BLE001 - un classeur illisible n'est pas un candidat
            return None
        return _columns_of(text)

    try:
        with open(path, "rb") as handle:
            raw = handle.read(SAMPLE_BYTES)
    except OSError:
        return None
    if not raw:
        return None

    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:  # pragma: no cover - latin-1 accepte tout
        return None

    return _columns_of(text)


def _columns_of(text: str) -> list[str] | None:
    """Colonnes reconnues dans ce texte delimite, ou None."""
    import csv as csv_module

    from jarvis_core.business.csv_import import (
        COLUMN_ALIASES,
        DATE_ALIASES,
        _fold,
        _looks_like_header,
        _sniff,
    )

    delimiter = _sniff(text[:2048])
    for line in text.splitlines()[:20]:
        cells = next(csv_module.reader([line], delimiter=delimiter), [])
        if not _looks_like_header(cells):
            continue
        folded = [_fold(cell) for cell in cells]
        found = [
            cell
            for cell in cells
            if _fold(cell) in DATE_ALIASES
            or any(_fold(cell) in aliases for aliases in COLUMN_ALIASES.values())
        ]
        return found or folded
    return None


def _inspect(folder: Path) -> Candidate | None:
    """Le dossier contient-il un rapport lisible ?"""
    try:
        files = [
            item
            for item in folder.iterdir()
            if item.is_file() and item.suffix.lower() in SUFFIXES
        ]
    except OSError:
        return None
    if not files:
        return None

    # Le plus recent d'abord: c'est celui qui ressemble le plus a un rapport
    # courant, et il evite de juger un dossier sur une vieille exception.
    try:
        files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    except OSError:
        return None

    for item in files[:8]:
        columns = _readable_header(item)
        if columns is None:
            continue
        try:
            newest = time.strftime("%Y-%m-%d", time.localtime(files[0].stat().st_mtime))
        except OSError:
            newest = ""
        return Candidate(
            path=str(folder),
            sample=item.name,
            columns=columns[:8],
            files=len(files),
            newest=newest,
        )
    return None


def discover(
    roots: list[Path] | None = None,
    *,
    max_seconds: float = MAX_SECONDS,
    max_directories: int = MAX_DIRECTORIES,
    max_depth: int = MAX_DEPTH,
) -> DiscoveryReport:
    """Cherche les dossiers contenant des rapports lisibles."""
    started = time.monotonic()
    report = DiscoveryReport()
    search = roots if roots is not None else default_roots()
    report.roots = [str(item) for item in search]

    queue: list[tuple[Path, int]] = [(root, 0) for root in search]
    seen: set[str] = set()

    while queue:
        if time.monotonic() - started > max_seconds:
            report.truncated = True
            break
        if report.scanned >= max_directories:
            report.truncated = True
            break
        if len(report.candidates) >= MAX_CANDIDATES:
            report.truncated = True
            break

        folder, depth = queue.pop(0)
        try:
            # `resolve` casse les boucles de liens symboliques, qui feraient
            # tourner la recherche indefiniment.
            key = str(folder.resolve())
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        report.scanned += 1

        found = _inspect(folder)
        if found is not None:
            report.candidates.append(found)

        if depth >= max_depth:
            continue
        try:
            children = [item for item in folder.iterdir() if item.is_dir()]
        except OSError:
            # Dossier protege ou lecteur deconnecte: on passe, sans bruit.
            continue
        for child in children:
            if child.name.lower() in IGNORED or child.name.startswith("."):
                continue
            queue.append((child, depth + 1))

    report.seconds = time.monotonic() - started
    return report
