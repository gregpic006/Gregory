"""Reglages modifiables depuis l'interface.

Raison d'etre: le proprietaire de ce projet n'est pas developpeur. Lui demander
d'ouvrir un fichier texte, d'y trouver la bonne ligne et de la modifier sans
faute de frappe transfere le travail du logiciel vers l'humain — et c'est la
cause la plus frequente de « ca marche pas ».

Deux limites volontaires.

**Aucun secret ne passe par ici.** Ni en lecture, ni en ecriture. Une cle
d'API se colle dans `.env`, point. Un formulaire web qui affiche des cles
serait une facon de les faire fuiter.

**Les capacites elevees ne se cochent pas.** Le controle de l'ordinateur et le
mode autonome restent modifiables uniquement dans `.env`. Une capacite qui
peut agir seule sur la machine ne doit pas s'activer d'un clic distrait.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from jarvis_core.config_sync import set_values
from jarvis_core.runtime import JarvisRuntime
from jarvis_core.setup_assistant import find_project_root

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/settings", tags=["settings"])


@dataclass(frozen=True)
class Toggle:
    """Un reglage booleen expose a l'interface."""

    key: str
    """Nom de la variable d'environnement."""
    field: str
    """Nom de l'attribut correspondant dans Settings."""
    label: str
    description: str
    needs_reconnect: bool = False
    """Vrai si activer demande de reconnecter un compte externe."""


#: Liste blanche stricte. Toute variable absente d'ici est inecrivable par
#: l'API, y compris si un client en fabrique le nom.
TOGGLES: tuple[Toggle, ...] = (
    Toggle(
        key="JARVIS_FEATURE_VOICE",
        field="feature_voice",
        label="Voix",
        description="Parler a JARVIS et l'entendre repondre.",
    ),
    Toggle(
        key="JARVIS_FEATURE_PERSISTENT_MEMORY",
        field="feature_persistent_memory",
        label="Memoire",
        description="Retenir les personnes, les entreprises et les decisions.",
    ),
    Toggle(
        key="JARVIS_FEATURE_DOCUMENTS",
        field="feature_documents",
        label="Documents",
        description="Chercher dans tes contrats, baux et notes.",
    ),
    Toggle(
        key="JARVIS_EMBEDDING_ENABLED",
        field="embedding_enabled",
        label="Recherche par le sens",
        description=(
            "Trouver une idee formulee autrement. Telecharge un modele "
            "d'environ 220 Mo au premier usage."
        ),
    ),
    Toggle(
        key="JARVIS_FEATURE_BUSINESS",
        field="feature_business",
        label="Donnees business",
        description="Ventes, couverts, masse salariale importes par CSV.",
    ),
    Toggle(
        key="JARVIS_FEATURE_PROACTIVE",
        field="feature_proactive",
        label="Surveillance proactive",
        description=(
            "Me prevenir d'une reunion imminente, d'un rappel echu ou de donnees "
            "business qui se sont arretees."
        ),
    ),
    Toggle(
        key="JARVIS_FEATURE_GMAIL",
        field="feature_gmail",
        label="Gmail",
        description="Lire, resumer et rediger des courriels.",
        needs_reconnect=True,
    ),
    Toggle(
        key="JARVIS_FEATURE_CALENDAR",
        field="feature_calendar",
        label="Calendrier",
        description="Consulter et modifier ton agenda Google.",
        needs_reconnect=True,
    ),
    Toggle(
        key="JARVIS_FEATURE_DRIVE",
        field="feature_drive",
        label="Google Drive",
        description=(
            "Indexer un dossier Drive. Demande une autorisation Google supplementaire."
        ),
        needs_reconnect=True,
    ),
)

BY_KEY = {toggle.key: toggle for toggle in TOGGLES}


class SettingsPatch(BaseModel):
    """Modification demandee par l'interface."""

    features: dict[str, bool] = Field(default_factory=dict)
    documents_dir: str | None = None


def get_runtime(request: Request) -> JarvisRuntime:
    runtime: JarvisRuntime = request.app.state.runtime
    return runtime


@router.get("")
async def read_settings(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Reglages modifiables et leur etat actuel. Aucun secret n'est renvoye."""
    settings = runtime.settings
    return {
        "features": [
            {
                "key": toggle.key,
                "label": toggle.label,
                "description": toggle.description,
                "enabled": bool(getattr(settings, toggle.field, False)),
                "needs_reconnect": toggle.needs_reconnect,
            }
            for toggle in TOGGLES
        ],
        "documents_dir": settings.documents_dir,
        "timezone": settings.timezone,
        # Presence seulement: jamais la valeur.
        "anthropic_key_present": bool(settings.anthropic_api_key),
        "google_configured": settings.google_configured,
    }


@router.patch("")
async def update_settings(
    patch: SettingsPatch, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Ecrit les reglages dans `.env`, en preservant tout le reste.

    Un redemarrage est necessaire: la configuration est lue une seule fois au
    demarrage, et la relire a chaud rendrait l'etat du systeme imprevisible en
    plein milieu d'une conversation.
    """
    unknown = sorted(set(patch.features) - set(BY_KEY))
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"Reglage non modifiable depuis l'interface: {', '.join(unknown)}",
        )

    values = {key: ("true" if enabled else "false") for key, enabled in patch.features.items()}

    if patch.documents_dir is not None:
        folder = patch.documents_dir.strip()
        if not folder:
            raise HTTPException(status_code=400, detail="Le dossier ne peut pas etre vide.")
        values["JARVIS_DOCUMENTS_DIR"] = folder

    if not values:
        return {"changed": [], "restart_needed": False, "reconnect_google": False}

    env_path = find_project_root() / ".env"
    if not env_path.is_file():
        raise HTTPException(
            status_code=400,
            detail="Le fichier .env est introuvable. Relance scripts/setup.ps1.",
        )

    try:
        changed = set_values(env_path, values)
    except OSError as exc:
        logger.warning("ecriture de .env impossible: %s", exc)
        raise HTTPException(
            status_code=500, detail="Je n'ai pas pu ecrire le fichier de configuration."
        ) from exc

    reconnect = any(
        BY_KEY[key].needs_reconnect
        for key in changed
        if key in BY_KEY and patch.features.get(key)
    )
    return {
        "changed": changed,
        "restart_needed": bool(changed),
        "reconnect_google": reconnect,
    }
