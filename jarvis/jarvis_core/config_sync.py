"""Reconciliation du fichier .env avec le modele .env.example.

Probleme concret que ce module resout: `.env` est cree une seule fois, puis
n'est plus jamais touche par git — c'est voulu, il contient des secrets. Mais
chaque jalon ajoute des variables au modele, et elles n'arrivent jamais dans le
fichier de l'utilisateur. Resultat: une integration configuree qui reste
invisible, sans aucun message d'erreur.

`sync_env` ajoute les cles manquantes en fin de fichier, **sans jamais toucher
a une valeur existante**.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

#: `CLE=valeur`, en ignorant les commentaires et les lignes vides.
_ASSIGNMENT = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")


def parse_keys(text: str) -> list[str]:
    """Cles declarees dans un fichier d'environnement, dans l'ordre."""
    keys: list[str] = []
    for line in text.splitlines():
        match = _ASSIGNMENT.match(line)
        if match and not line.lstrip().startswith("#"):
            keys.append(match.group(1))
    return keys


@dataclass
class SyncReport:
    """Resultat d'une reconciliation."""

    added: list[str] = field(default_factory=list)
    already_present: int = 0
    created: bool = False

    @property
    def changed(self) -> bool:
        return bool(self.added) or self.created


def _block_for(example_text: str, missing: set[str]) -> str:
    """Extrait du modele les lignes des cles manquantes, avec leur commentaire.

    On recopie le commentaire qui precede immediatement chaque cle: sans lui,
    l'utilisateur herite d'une variable dont il ignore le role.
    """
    lines = example_text.splitlines()
    chunks: list[str] = []
    pending_comment: list[str] = []

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#") and not set(stripped) <= {"#", " ", "-", "="}:
            pending_comment.append(line)
            continue
        if not stripped:
            pending_comment.clear()
            continue
        match = _ASSIGNMENT.match(line)
        if match and match.group(1) in missing:
            chunks.extend(pending_comment)
            chunks.append(line)
            chunks.append("")
        pending_comment.clear()
    return "\n".join(chunks)


def sync_env(env_path: Path, example_path: Path) -> SyncReport:
    """Ajoute a `.env` les cles presentes dans le modele et absentes du fichier.

    Aucune valeur existante n'est modifiee, aucune cle n'est supprimee: le
    fichier de l'utilisateur ne peut que gagner des lignes.
    """
    if not example_path.is_file():
        raise FileNotFoundError(f"modele introuvable: {example_path}")
    example_text = example_path.read_text(encoding="utf-8")

    if not env_path.is_file():
        env_path.write_text(example_text, encoding="utf-8")
        return SyncReport(added=parse_keys(example_text), created=True)

    env_text = env_path.read_text(encoding="utf-8")
    existing = set(parse_keys(env_text))
    expected = parse_keys(example_text)
    missing = [key for key in expected if key not in existing]

    if not missing:
        return SyncReport(already_present=len(existing))

    block = _block_for(example_text, set(missing))
    separator = "" if env_text.endswith("\n") else "\n"
    addition = (
        f"{separator}\n"
        "# ---------------------------------------------------------------------\n"
        "# Ajoute automatiquement depuis .env.example (nouvelles fonctionnalites).\n"
        "# ---------------------------------------------------------------------\n"
        f"{block}"
    )
    env_path.write_text(env_text + addition, encoding="utf-8")
    return SyncReport(added=missing, already_present=len(existing))
