"""Controle d'acces reseau.

Tant que JARVIS n'ecoute que sur `127.0.0.1`, seule la machine locale peut lui
parler: aucune authentification n'est necessaire, et en exiger une ne ferait
qu'ajouter une friction inutile.

Des que l'ecoute s'ouvre au reseau — pour y acceder depuis un telephone — la
situation change du tout au tout. N'importe qui sur le meme Wi-Fi pourrait
lire les courriels de l'utilisateur, consulter son agenda et ses chiffres
d'affaires. Le jeton devient alors **obligatoire**, verifie a chaque requete.

Le refus de demarrer est volontaire: mieux vaut une application qui ne se lance
pas qu'une application ouverte a tout le cafe sans que personne ne s'en
apercoive.
"""

from __future__ import annotations

import hmac
import logging
import secrets
from ipaddress import ip_address
from typing import Any

from jarvis_core.errors import ConfigurationError

logger = logging.getLogger(__name__)

#: Chemins joignables sans jeton. `/api/health` sert aux verifications de
#: demarrage et ne revele rien; la page elle-meme doit pouvoir se charger pour
#: afficher le champ ou saisir le jeton.
PUBLIC_PATHS = frozenset({"/api/health"})

#: En-tete et parametre acceptes pour transmettre le jeton.
HEADER = "X-Jarvis-Token"
QUERY_PARAM = "token"

TOKEN_BYTES = 24


def generate_token() -> str:
    """Jeton d'acces aleatoire, sur pour un usage reseau."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def is_loopback(host: str) -> bool:
    """Vrai si l'adresse d'ecoute ne sort pas de la machine."""
    cleaned = (host or "").strip()
    if cleaned in {"localhost", ""}:
        return True
    try:
        return ip_address(cleaned).is_loopback
    except ValueError:
        # Un nom d'hote quelconque: on ne peut pas garantir qu'il est local.
        return False


def requires_token(host: str) -> bool:
    """Vrai si l'ecoute depasse la machine et exige donc une authentification."""
    return not is_loopback(host)


def validate_configuration(*, host: str, token: str) -> None:
    """Refuse une exposition reseau sans jeton.

    Raises:
        ConfigurationError: ecoute ouverte au reseau sans jeton configure.
    """
    if not requires_token(host):
        return
    if token.strip():
        return
    raise ConfigurationError(
        f"ecoute sur {host} sans jeton d'acces",
        user_message=(
            f"JARVIS est configure pour ecouter sur {host}, donc accessible "
            "depuis le reseau — mais aucun jeton d'acces n'est defini. "
            "N'importe qui sur le meme Wi-Fi pourrait lire tes courriels. "
            "Lance: jarvis remote --enable"
        ),
    )


def token_matches(expected: str, received: str) -> bool:
    """Comparaison a temps constant.

    Un `==` classique s'arrete au premier caractere different, ce qui laisse
    mesurer la duree pour deviner le jeton caractere par caractere.
    """
    if not expected:
        return False
    return hmac.compare_digest(expected, received or "")


def extract_token(headers: Any, query_params: Any) -> str:
    """Recupere le jeton d'une requete, en-tete d'abord.

    Le parametre d'URL existe pour le premier acces depuis un telephone (on ne
    peut pas taper un en-tete dans un navigateur); l'interface le range ensuite
    et n'utilise plus que l'en-tete.
    """
    header_value = ""
    try:
        header_value = headers.get(HEADER) or headers.get(HEADER.lower()) or ""
    except AttributeError:
        header_value = ""
    if header_value:
        return str(header_value).strip()

    authorization = ""
    try:
        authorization = headers.get("Authorization") or ""
    except AttributeError:
        authorization = ""
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()

    try:
        return str(query_params.get(QUERY_PARAM) or "").strip()
    except AttributeError:
        return ""
