"""Configuration automatique de JARVIS.

Ce module existe pour une raison precise: le proprietaire de ce projet n'est
pas developpeur.  Lui demander d'ouvrir un fichier texte, de trouver la bonne
ligne parmi soixante et de la modifier sans faute de frappe, c'est deplacer le
travail du logiciel vers l'humain.

`jarvis setup` prend donc les decisions raisonnables tout seul: il active ce
qui doit l'etre, cree les dossiers manquants, et n'ecrit dans `.env` que ce
qui change reellement.  Il ne touche jamais a une cle d'API, jamais a un
reglage deja choisi volontairement.

Ce qu'il ne peut pas faire — obtenir une cle Anthropic, autoriser un compte
Google — il le dit en une phrase avec la marche a suivre.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

from jarvis_core.config import Settings
from jarvis_core.config_sync import set_values, sync_env
from jarvis_core.deps import ensure_installed

logger = logging.getLogger(__name__)

#: Reglages actives d'office: ils ne coutent rien, ne dependent d'aucun compte
#: externe, et leur absence est la cause la plus frequente de « ca marche pas ».
RECOMMENDED: dict[str, str] = {
    "JARVIS_FEATURE_DOCUMENTS": "true",
    "JARVIS_FEATURE_BUSINESS": "true",
    "JARVIS_FEATURE_PERSISTENT_MEMORY": "true",
}


@dataclass
class SetupStep:
    """Une action effectuee, ou une chose a faire par l'utilisateur."""

    label: str
    done: bool
    detail: str = ""
    action: str = ""
    """Ce que l'utilisateur doit faire lui-meme, quand JARVIS ne peut pas."""
    optional: bool = False
    """Vrai si JARVIS fonctionne tres bien sans. Ne bloque rien."""


@dataclass
class SetupReport:
    steps: list[SetupStep] = field(default_factory=list)
    changed_keys: list[str] = field(default_factory=list)
    restart_needed: bool = False

    @property
    def blocking(self) -> list[SetupStep]:
        """Ce qui empeche reellement JARVIS de fonctionner."""
        return [
            step for step in self.steps if not step.done and step.action and not step.optional
        ]

    @property
    def optional_todo(self) -> list[SetupStep]:
        """Ce qui ajouterait des capacites, sans etre necessaire."""
        return [step for step in self.steps if not step.done and step.optional]

    def add(
        self,
        label: str,
        done: bool,
        detail: str = "",
        action: str = "",
        optional: bool = False,
    ) -> None:
        self.steps.append(
            SetupStep(label=label, done=done, detail=detail, action=action, optional=optional)
        )


def find_project_root() -> Path:
    """Racine du projet: la ou vivent `.env` et `.env.example`.

    On regarde d'abord le dossier courant et ses parents — c'est la que
    l'utilisateur se trouve quand il lance la commande — avant de retomber sur
    l'emplacement du paquet. Sans cela, lancer JARVIS depuis un autre dossier
    configurerait un `.env` qui n'est pas le sien.
    """
    package_root = Path(__file__).resolve().parent.parent
    candidates = [Path.cwd(), *Path.cwd().parents]
    for candidate in candidates:
        if (candidate / ".env").is_file() and (candidate / ".env.example").is_file():
            return candidate
    for candidate in candidates:
        if (candidate / ".env.example").is_file():
            return candidate
    return package_root


def default_documents_dir() -> Path:
    """Dossier de documents choisi automatiquement.

    Sous Windows, `Documents\\JARVIS` est l'endroit ou un utilisateur ira
    naturellement deposer ses fichiers. Ailleurs, on reste dans le projet.
    """
    if os.name == "nt":
        profile = os.environ.get("USERPROFILE", "")
        if profile:
            return Path(profile) / "Documents" / "JARVIS"
    home = Path.home()
    documents = home / "Documents"
    if documents.is_dir():
        return documents / "JARVIS"
    return Path("data/documents").resolve()


def run_setup(root: Path, settings: Settings) -> SetupReport:
    """Configure ce qui peut l'etre, signale le reste.

    Args:
        root: racine du projet (contient `.env` et `.env.example`).
    """
    report = SetupReport()
    env_path = root / ".env"
    example_path = root / ".env.example"

    # 1. Le fichier .env existe-t-il ?
    if not env_path.exists():
        report.add(
            "Fichier .env",
            done=False,
            detail="absent",
            action=(
                "Relance l'installation: powershell -ExecutionPolicy Bypass "
                "-File .\\scripts\\setup.ps1"
            ),
        )
        return report

    # 2. Ajouter les variables des nouveaux jalons, sans toucher aux valeurs.
    sync = sync_env(env_path, example_path)
    if sync.added:
        report.add(
            "Nouvelles options",
            done=True,
            detail=f"{len(sync.added)} variable(s) ajoutee(s) au fichier .env",
        )
        report.restart_needed = True
    else:
        report.add("Nouvelles options", done=True, detail="fichier deja a jour")

    # 3. Choisir un dossier de documents et le creer.
    desired: dict[str, str] = dict(RECOMMENDED)
    current_dir = settings.documents_dir.strip()
    folder = Path(current_dir).expanduser() if current_dir else default_documents_dir()
    if not current_dir or current_dir == "data/documents":
        folder = default_documents_dir()
        desired["JARVIS_DOCUMENTS_DIR"] = str(folder)

    try:
        folder.mkdir(parents=True, exist_ok=True)
        existing = [p for p in folder.iterdir() if p.is_file()] if folder.is_dir() else []
        report.add(
            "Dossier de documents",
            done=True,
            detail=f"{folder} ({len(existing)} fichier(s))",
        )
    except OSError as exc:
        report.add(
            "Dossier de documents",
            done=False,
            detail=str(exc),
            action=f"Cree le dossier a la main: {folder}",
        )

    # 3a. Les paquets. Une mise a jour peut en ajouter; `git pull` ne les
    # installe pas. Sans ce controle, la fonctionnalite est morte en silence.
    absent, dependency_error = ensure_installed(root)
    if dependency_error:
        report.add(
            "Dependances",
            done=False,
            detail=dependency_error,
            action="Lance: .\\.venv\\Scripts\\python.exe -m pip install -e .",
        )
    elif absent:
        report.add(
            "Dependances",
            done=True,
            detail=f"{len(absent)} paquet(s) installe(s): "
            + ", ".join(item.feature for item in absent),
        )
        report.restart_needed = True
    else:
        report.add("Dependances", done=True, detail="a jour")

    # 3b. La voix. `null` fait parler le navigateur, ce qui sonne comme un GPS.
    # On bascule vers les voix neuronales — mais seulement depuis `null`: un
    # choix delibere (ElevenLabs, OpenAI) n'est jamais ecrase.
    if settings.tts_provider == "null":
        desired["JARVIS_TTS_PROVIDER"] = "edge"
        report.add("Voix", done=True, detail="voix neuronale activee (aucune cle requise)")
    else:
        report.add("Voix", done=True, detail=f"moteur {settings.tts_provider}")

    # 4. Dossier d'import business, avec un sous-dossier par entreprise.
    if settings.feature_business and settings.business_watch_dir.strip():
        _prepare_business_folders(root, settings, report)

    # 5. Activer ce qui doit l'etre.
    changed = set_values(env_path, desired)
    report.changed_keys = changed
    if changed:
        report.restart_needed = True
        report.add(
            "Fonctionnalites",
            done=True,
            detail=f"activees: {', '.join(sorted(changed))}",
        )
    else:
        report.add("Fonctionnalites", done=True, detail="deja activees")

    # 6. Ce que JARVIS ne peut pas faire a la place de l'utilisateur.
    if not settings.anthropic_api_key:
        report.add(
            "Cle Claude",
            done=False,
            detail="absente",
            action=(
                "Cree une cle sur console.anthropic.com puis colle-la dans .env "
                "sur la ligne ANTHROPIC_API_KEY="
            ),
        )
    else:
        report.add("Cle Claude", done=True, detail="presente")

    if settings.google_configured:
        report.add("Google", done=True, detail="identifiants presents")
    else:
        report.add(
            "Google",
            done=False,
            detail="non configure",
            action="Voir docs/google-setup.md, quand tu voudras.",
            optional=True,
        )

    return report


def _prepare_business_folders(
    root: Path, settings: Settings, report: SetupReport
) -> None:
    """Cree un sous-dossier par entreprise, nomme d'apres son identifiant.

    Sans cela, l'utilisateur devrait deviner la convention de nommage — et un
    dossier mal nomme est ignore en silence par la surveillance.
    """
    from jarvis_core.business.watch_folder import ensure_layout
    from jarvis_core.persistence.db import build_database

    target = Path(settings.business_watch_dir).expanduser()
    if not target.is_absolute():
        target = root / target

    try:
        db = build_database(settings.database_url)
        db.migrate()
        org_ids = [
            str(row["id"])
            for row in db.query(
                "SELECT id FROM organizations WHERE id != 'PERSONAL' AND archived = 0"
            )
        ]
        db.close()
        created = ensure_layout(target, org_ids)
    except Exception as exc:  # noqa: BLE001 - un echec ici n'empeche rien d'autre
        report.add(
            "Dossier d'import business",
            done=False,
            detail=str(exc)[:120],
            action=f"Cree le dossier a la main: {target}",
        )
        return

    detail = f"{target} ({len(org_ids)} entreprise(s))"
    if created:
        detail += f" — {len(created)} sous-dossier(s) cree(s)"
    report.add("Dossier d'import business", done=True, detail=detail)


def render_report(report: SetupReport) -> None:
    """Affiche le rapport en francais clair, sans jargon."""
    print("Configuration de JARVIS\n")
    for step in report.steps:
        if step.done:
            mark = "[ ok  ]"
        elif step.optional:
            mark = "[option]"
        else:
            mark = "[A FAIRE]"
        print(f"  {mark:<9} {step.label:<24} {step.detail}")
        if step.action:
            print(f"            -> {step.action}")

    print()
    if report.blocking:
        print("Il reste une chose que je ne peux pas faire a ta place:")
        for step in report.blocking:
            print(f"  {step.action}")
    elif report.optional_todo:
        names = ", ".join(step.label for step in report.optional_todo)
        print(f"Tout est configure. En option, tu pourrais encore brancher: {names}.")
    else:
        print("Tout est configure. Rien a faire de ton cote.")
