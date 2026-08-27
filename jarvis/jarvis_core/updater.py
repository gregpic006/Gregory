"""Mise a jour de JARVIS depuis l'interface.

Le proprietaire de ce projet n'est pas developpeur. Lui demander d'ouvrir un
terminal, de taper `git pull`, puis de relancer un script apres chaque
changement, c'est lui faire porter le travail de la machine — et c'est la
source de frustration la plus constante de ce projet.

Ce module met a jour le code, recompile l'interface et laisse le processus se
relancer. Un bouton, rien d'autre.

Trois garde-fous, parce que ce module execute des commandes:

**Aucune commande n'est composee a partir d'une saisie.** Les arguments sont
des constantes du fichier; rien de ce que l'utilisateur tape n'y entre.

**On ne met a jour qu'un depot propre.** Si des fichiers ont ete modifies sur
place, on refuse plutot que d'ecraser un travail qu'on ne comprend pas.

**Avance rapide seulement.** Pas de fusion, pas de rebase: si l'historique a
diverge, la situation demande un humain.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

#: Au-dela, une commande est consideree bloquee.
GIT_TIMEOUT = 90
BUILD_TIMEOUT = 420

#: Code de sortie convenu avec le script de demarrage: il relance le processus
#: au lieu de rendre la main.
RESTART_EXIT_CODE = 42


@dataclass
class UpdateStatus:
    """Ce que l'on sait de l'etat du depot."""

    available: bool = False
    behind: int = 0
    clean: bool = True
    current: str = ""
    branch: str = ""
    changes: list[str] = field(default_factory=list)
    error: str = ""
    blocked: str = ""
    """Raison pour laquelle la mise a jour est impossible, s'il y en a une."""

    def as_dict(self) -> dict[str, object]:
        return {
            "available": self.available,
            "behind": self.behind,
            "clean": self.clean,
            "current": self.current,
            "branch": self.branch,
            "changes": self.changes,
            "error": self.error,
            "blocked": self.blocked,
        }


@dataclass
class UpdateResult:
    """Resultat d'une mise a jour appliquee."""

    updated: bool = False
    restarted: bool = False
    detail: str = ""
    error: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "updated": self.updated,
            "restarted": self.restarted,
            "detail": self.detail,
            "error": self.error,
        }


def _git(root: Path, *args: str, timeout: int = GIT_TIMEOUT) -> subprocess.CompletedProcess[str]:
    """Execute git sans passer par un interpreteur de commandes.

    `shell=False` (le defaut) est essentiel: aucune chaine n'est interpretee,
    donc rien ne peut s'y glisser.
    """
    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def find_repo_root(start: Path) -> Path | None:
    """Remonte jusqu'au dossier contenant `.git`.

    Selon la facon dont le projet a ete clone, `jarvis/` est soit la racine du
    depot, soit un sous-dossier. Supposer l'un des deux ferait echouer la mise
    a jour dans l'autre cas.
    """
    for candidate in [start, *start.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def check_update(root: Path) -> UpdateStatus:
    """Regarde s'il existe une version plus recente, sans rien modifier."""
    status = UpdateStatus()

    repo = find_repo_root(root)
    if repo is None:
        status.blocked = (
            "Ce dossier n'est pas un depot git: la mise a jour automatique "
            "ne s'applique pas."
        )
        return status
    root = repo

    try:
        head = _git(root, "rev-parse", "--short", "HEAD")
        status.current = head.stdout.strip()

        branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD")
        status.branch = branch.stdout.strip()

        dirty = _git(root, "status", "--porcelain")
        status.clean = not dirty.stdout.strip()

        fetched = _git(root, "fetch", "--quiet")
        if fetched.returncode != 0:
            status.error = "Impossible de joindre GitHub. Verifie ta connexion."
            return status

        counts = _git(root, "rev-list", "--count", "HEAD..@{upstream}")
        if counts.returncode != 0:
            status.blocked = "Cette branche ne suit aucune branche distante."
            return status
        status.behind = int(counts.stdout.strip() or "0")
        status.available = status.behind > 0

        if status.available:
            log = _git(
                root, "log", "--pretty=format:%s", "--no-merges", "HEAD..@{upstream}"
            )
            status.changes = [line for line in log.stdout.splitlines() if line.strip()][:12]

        if status.available and not status.clean:
            status.blocked = (
                "Des fichiers ont ete modifies sur place. La mise a jour les "
                "ecraserait, donc elle est refusee."
            )
    except (subprocess.TimeoutExpired, OSError, ValueError) as exc:
        logger.warning("verification de mise a jour impossible: %s", exc)
        status.error = "La verification a echoue."
    return status


def apply_update(root: Path, *, build: bool = True) -> UpdateResult:
    """Recupere la nouvelle version et recompile l'interface.

    Ne redemarre pas: c'est a l'appelant de le faire, une fois la reponse
    envoyee au navigateur.
    """
    result = UpdateResult()
    repo = find_repo_root(root)
    if repo is None:
        result.error = "Ce dossier n'est pas un depot git."
        return result
    status = check_update(repo)

    if status.error:
        result.error = status.error
        return result
    if status.blocked:
        result.error = status.blocked
        return result
    if not status.available:
        result.detail = "JARVIS est deja a jour."
        return result

    try:
        # `--ff-only`: si l'historique a diverge, on s'arrete plutot que de
        # fabriquer une fusion que personne n'a demandee.
        pull = _git(repo, "merge", "--ff-only", "@{upstream}")
        if pull.returncode != 0:
            result.error = (
                "La mise a jour demande une intervention manuelle "
                "(historique divergent)."
            )
            return result
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("mise a jour impossible: %s", exc)
        result.error = "La mise a jour a echoue."
        return result

    result.updated = True
    result.detail = f"{status.behind} changement(s) recupere(s)."

    # Une nouvelle version peut ajouter une dependance Python. Recuperer le
    # code sans l'installer laisse une fonctionnalite morte, et le message
    # d'erreur qui en decoule designe la mauvaise cause.
    from jarvis_core.deps import ensure_installed

    installed, dependency_error = ensure_installed(root)
    if dependency_error:
        result.error = dependency_error
        return result
    if installed:
        result.detail += f" {len(installed)} paquet(s) installe(s)."

    if build:
        # L'interface vit dans jarvis/ui, qui n'est pas forcement la racine du
        # depot: on part du dossier fourni, pas du depot.
        built, message = rebuild_interface(root)
        if not built:
            # Le code est a jour mais l'interface ne l'est pas: on le dit
            # plutot que de laisser croire a une reussite complete.
            result.error = message
            return result
        result.detail += " Interface recompilee."

    return result


def rebuild_interface(root: Path) -> tuple[bool, str]:
    """Recompile l'interface. Retourne (succes, message)."""
    ui = root / "ui"
    if not (ui / "package.json").exists():
        return True, "Aucune interface a recompiler."

    npm = "npm.cmd" if Path("C:/").exists() else "npm"
    try:
        if not (ui / "node_modules").exists():
            install = subprocess.run(
                [npm, "install"],
                cwd=ui,
                capture_output=True,
                text=True,
                timeout=BUILD_TIMEOUT,
                check=False,
            )
            if install.returncode != 0:
                return False, "Installation des dependances de l'interface impossible."

        build = subprocess.run(
            [npm, "run", "build"],
            cwd=ui,
            capture_output=True,
            text=True,
            timeout=BUILD_TIMEOUT,
            check=False,
        )
        if build.returncode != 0:
            tail = (build.stderr or build.stdout)[-300:]
            return False, f"Recompilation de l'interface impossible: {tail}"
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("recompilation impossible: %s", exc)
        return False, "La recompilation de l'interface a echoue."
    return True, "Interface recompilee."
