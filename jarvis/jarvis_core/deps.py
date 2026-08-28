"""Verifie que les paquets necessaires sont bien installes.

Une mise a jour peut ajouter une dependance. `git pull` recupere le code, mais
**n'installe rien**: le fichier `pyproject.toml` change, la bibliotheque
manque, et JARVIS demarre en silence avec une fonctionnalite morte.

C'est arrive exactement comme ca: la voix neuronale a ete ajoutee, le
proprietaire a mis a jour, et l'interface lui a repondu « verifie ta
connexion » alors que sa connexion allait tres bien — il manquait un paquet.
Un message faux est pire qu'une panne.

Ce module ferme les deux trous: il **dit** ce qui manque, et il l'installe.

Deux precautions.

**On n'installe que ce projet.** La commande est fixe (`pip install -e .`) et
ne se compose a partir de rien: aucun nom venant d'ailleurs n'y entre.

**Un echec d'installation n'empeche pas de demarrer.** JARVIS fonctionne sans
la voix neuronale — moins bien, mais il fonctionne. On le signale, on ne
bloque pas.
"""

from __future__ import annotations

import importlib.util
import logging
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

#: Au-dela, l'installation est consideree bloquee.
INSTALL_TIMEOUT = 300


@dataclass(frozen=True)
class Requirement:
    """Un paquet dont l'absence retire une fonctionnalite visible."""

    module: str
    """Nom d'import, pas le nom pip: `edge_tts`, pas `edge-tts`."""
    feature: str
    """Ce que l'utilisateur perd si le paquet manque."""


#: Paquets obligatoires ajoutes apres la premiere installation. Les paquets
#: presents depuis le debut n'ont pas besoin d'y figurer: si `fastapi` manque,
#: rien ne demarre et le probleme se voit tout seul.
REQUIRED: tuple[Requirement, ...] = (
    Requirement(module="edge_tts", feature="la voix neuronale"),
    Requirement(module="openpyxl", feature="la lecture des rapports Excel"),
)


def is_installed(module: str) -> bool:
    """Le module est-il importable, sans l'importer reellement ?

    `find_spec` evite d'executer le paquet: on veut savoir s'il est la, pas
    payer son chargement a chaque demarrage.
    """
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def missing() -> list[Requirement]:
    """Paquets obligatoires absents."""
    return [item for item in REQUIRED if not is_installed(item.module)]


def install_project(root: Path) -> tuple[bool, str]:
    """Installe le projet et ses dependances. Retourne (succes, message).

    Utilise l'interpreteur courant: dans un environnement virtuel, c'est celui
    de l'environnement, donc l'installation va au bon endroit sans avoir a
    deviner un chemin.
    """
    if not (root / "pyproject.toml").exists():
        return False, "pyproject.toml introuvable: installation impossible."
    try:
        done = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-e", ".", "--quiet"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=INSTALL_TIMEOUT,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("installation des dependances impossible: %s", exc)
        return False, "L'installation des dependances a echoue."
    if done.returncode != 0:
        tail = (done.stderr or done.stdout).strip()[-300:]
        return False, f"Installation des dependances impossible: {tail}"
    return True, "Dependances installees."


def ensure_installed(root: Path) -> tuple[list[Requirement], str]:
    """Installe ce qui manque. Retourne (ce qui manquait, message d'erreur).

    Un message vide signifie que tout est en place — soit rien ne manquait,
    soit l'installation a reussi.
    """
    absent = missing()
    if not absent:
        return [], ""
    logger.info(
        "paquet(s) manquant(s): %s — installation",
        ", ".join(item.module for item in absent),
    )
    ok, message = install_project(root)
    if not ok:
        return absent, message
    # On revérifie plutot que de croire le code de retour: pip peut reussir
    # sans avoir installe ce qu'on attendait.
    still = missing()
    if still:
        return absent, (
            "Installes sans effet: " + ", ".join(item.module for item in still)
        )
    return absent, ""
