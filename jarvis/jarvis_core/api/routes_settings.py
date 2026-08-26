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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
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


# --- mise a jour --------------------------------------------------------------


@router.get("/update")
async def check_for_update(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Y a-t-il une version plus recente ? Ne modifie rien."""
    from jarvis_core.updater import check_update

    return check_update(find_project_root()).as_dict()


@router.post("/update")
async def install_update(
    background: BackgroundTasks, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Recupere la nouvelle version, recompile, puis redemarre.

    Le redemarrage part en tache de fond: sans cela le processus mourrait
    avant d'avoir repondu, et l'interface resterait sur un chargement infini
    sans savoir si la mise a jour a reussi.
    """
    from jarvis_core.updater import apply_update

    result = apply_update(find_project_root())
    if result.updated and not result.error:
        background.add_task(_restart_soon)
        result.restarted = True
    return result.as_dict()


def _restart_soon() -> None:
    """Quitte avec le code convenu, apres avoir laisse partir la reponse.

    `start.ps1` relance alors le processus. Le delai laisse le temps au
    navigateur de recevoir la reponse et d'afficher le message.
    """
    import os
    import threading

    from jarvis_core.updater import RESTART_EXIT_CODE

    def stop() -> None:
        logger.info("redemarrage apres mise a jour")
        # `os._exit` plutot que sys.exit: on veut sortir du processus entier,
        # sans laisser uvicorn intercepter et annuler l'arret.
        os._exit(RESTART_EXIT_CODE)

    threading.Timer(1.5, stop).start()


# ------------------------------------------------------------------- la voix
#
# Choisir une voix se fait par l'oreille, pas par la documentation. Ces routes
# existent pour qu'on puisse comparer et entendre, sans jamais ouvrir .env.


class VoiceChange(BaseModel):
    """Voix, tenue et registre demandes."""

    voice: str = Field(default="", max_length=120)
    delivery: str = Field(default="", max_length=40)
    #: "monsieur" ou "familier". Le registre fait autant que le timbre.
    address: str = Field(default="", max_length=20)


@router.get("/voice")
async def read_voice(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Voix disponibles, voix retenue, tenues proposees.

    Le catalogue vient du service, jamais d'une liste ecrite ici: une liste
    figee finirait par proposer des voix qui n'existent plus.
    """
    from jarvis_core.voice.delivery import DELIVERIES, get_delivery

    settings = runtime.settings
    payload: dict[str, Any] = {
        "provider": settings.tts_provider,
        "deliveries": [d.as_dict() for d in DELIVERIES],
        "delivery": get_delivery(settings.tts_delivery).key,
        "voice": settings.tts_edge_voice,
        "address": settings.persona_address,
        "resolved": "",
        "voices": [],
        "error": "",
    }

    provider = getattr(runtime, "tts", None)
    if settings.tts_provider != "edge" or provider is None:
        payload["error"] = (
            "Le choix de la voix ne s'applique qu'au moteur neuronal (edge)."
        )
        return payload

    try:
        voices = await provider.french_voices()
        payload["voices"] = [v.as_dict() for v in voices]
        payload["resolved"] = await provider.resolve_voice()
    except Exception as exc:  # noqa: BLE001 - une panne se dit, ne s'invente pas
        logger.warning("catalogue de voix indisponible: %s", exc)

    if not payload["voices"]:
        payload["error"] = (
            "Impossible de joindre le service de voix. Verifie ta connexion."
        )
    return payload


@router.post("/voice")
async def change_voice(
    change: VoiceChange, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Enregistre le choix et l'applique immediatement.

    Ecrit dans .env pour que le choix survive au redemarrage, et met a jour le
    moteur en memoire pour qu'il vaille des la phrase suivante — sans quoi il
    faudrait relancer JARVIS pour s'entendre.
    """
    from jarvis_core.voice.delivery import get_delivery

    values: dict[str, str] = {}
    if change.voice:
        values["JARVIS_TTS_EDGE_VOICE"] = change.voice
    delivery = None
    if change.delivery:
        delivery = get_delivery(change.delivery)
        values["JARVIS_TTS_DELIVERY"] = delivery.key
    address = change.address.strip().lower()
    if address in {"monsieur", "familier"}:
        values["JARVIS_PERSONA_ADDRESS"] = address
    if not values:
        raise HTTPException(status_code=400, detail="Rien a changer.")

    set_values(find_project_root() / ".env", values)

    provider = getattr(runtime, "tts", None)
    applied = False
    if provider is not None and getattr(provider, "name", "") == "edge":
        if change.voice:
            provider.configured_voice = change.voice
        if delivery is not None:
            provider.rate = delivery.rate
            provider.pitch = delivery.pitch
        applied = True

    if change.voice:
        runtime.settings.tts_edge_voice = change.voice
    if delivery is not None:
        runtime.settings.tts_delivery = delivery.key
    if address in {"monsieur", "familier"}:
        # Le prompt systeme est reconstruit a chaque tour: changer le reglage
        # en memoire suffit pour que la phrase suivante en tienne compte.
        runtime.settings.persona_address = address

    return {"saved": True, "applied": applied}


@router.post("/voice/test")
async def test_voice(
    change: VoiceChange, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Fait entendre une phrase avec les reglages demandes, sans les enregistrer.

    Comparer avant de choisir: c'est la seule facon honnete de regler une voix.
    """
    import base64

    from jarvis_core.voice.delivery import get_delivery

    provider = getattr(runtime, "tts", None)
    if provider is None or getattr(provider, "name", "") != "edge":
        raise HTTPException(status_code=400, detail="Le moteur neuronal n'est pas actif.")

    # Reglages d'essai poses le temps de la phrase, puis rendus tels quels:
    # ecouter ne doit rien changer tant qu'on n'a pas choisi.
    before = (provider.rate, provider.pitch)
    if change.delivery:
        delivery = get_delivery(change.delivery)
        provider.rate, provider.pitch = delivery.rate, delivery.pitch
    try:
        audio = await provider.synthesize(SAMPLE_LINE, voice=change.voice or None)
    finally:
        provider.rate, provider.pitch = before

    if audio is None:
        raise HTTPException(
            status_code=502,
            detail="Le service de voix n'a rien renvoye. Verifie ta connexion.",
        )
    return {
        "audio": base64.b64encode(audio.data).decode("ascii"),
        "mime": audio.mime,
    }


#: Phrase d'essai. Assez longue pour juger le debit, assez courte pour la
#: reecouter dix fois de suite sans s'agacer.
SAMPLE_LINE = (
    "Bonsoir Monsieur. Tous les systemes sont operationnels. "
    "Je vous ecoute."
)
