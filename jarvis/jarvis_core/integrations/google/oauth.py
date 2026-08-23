"""OAuth 2.0 Google, flux Authorization Code + PKCE.

Choix et justifications:

* **PKCE obligatoire.** Une application de bureau ne peut pas garder un secret;
  PKCE empeche qu'un code intercepte soit echangeable par un tiers.
* **Redirection en boucle locale** (`http://127.0.0.1:port/...`): le code
  n'emprunte jamais un serveur distant.
* **`state` aleatoire**, verifie au retour: protection CSRF.
* **Moindre privilege**: les portees demandees decoulent des feature flags
  actifs. Si le calendrier est desactive, sa portee n'est pas demandee.
* Le mot de passe Google n'est ni demande, ni vu, ni stocke.

Points de terminaison confirmes contre le document de decouverte OpenID de
Google (`accounts.google.com/.well-known/openid-configuration`).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx

from jarvis_core.errors import IntegrationNotConfiguredError, IntegrationUnavailableError

logger = logging.getLogger(__name__)

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke"
USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"

#: Portees minimales par capacite. Chacune est demandee seulement si le feature
#: flag correspondant est actif.
SCOPES_IDENTITY = ("openid", "email", "profile")
SCOPES_GMAIL_READ = ("https://www.googleapis.com/auth/gmail.readonly",)
#: `gmail.compose` couvre la creation de brouillons ET l'envoi.
SCOPES_GMAIL_WRITE = ("https://www.googleapis.com/auth/gmail.compose",)
#: `calendar.events` couvre lecture et ecriture des evenements, rien d'autre.
SCOPES_CALENDAR = ("https://www.googleapis.com/auth/calendar.events",)
SCOPES_CONTACTS = ("https://www.googleapis.com/auth/contacts.readonly",)

#: Duree de vie d'une demande d'autorisation en attente.
PENDING_TTL_SECONDS = 600


def scopes_for(*, gmail: bool, gmail_write: bool, calendar: bool, contacts: bool) -> list[str]:
    """Portees a demander compte tenu des capacites activees."""
    scopes: list[str] = list(SCOPES_IDENTITY)
    if gmail:
        scopes.extend(SCOPES_GMAIL_READ)
        if gmail_write:
            scopes.extend(SCOPES_GMAIL_WRITE)
    if calendar:
        scopes.extend(SCOPES_CALENDAR)
    if contacts:
        scopes.extend(SCOPES_CONTACTS)
    return scopes


@dataclass
class OAuthToken:
    """Reponse du point de terminaison de jetons, normalisee."""

    access_token: str
    refresh_token: str
    token_type: str
    scopes: list[str]
    expires_at: datetime


@dataclass
class _PendingAuthorization:
    """Demande d'autorisation en cours, en attente du retour de Google."""

    code_verifier: str
    scopes: list[str]
    created_at: float = field(default_factory=time.monotonic)

    def is_stale(self) -> bool:
        return time.monotonic() - self.created_at > PENDING_TTL_SECONDS


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


class GoogleOAuth:
    """Pilote le flux d'autorisation et le rafraichissement des jetons."""

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self._client = client or httpx.AsyncClient(timeout=20.0)
        self._pending: dict[str, _PendingAuthorization] = {}

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def _require_configuration(self) -> None:
        if not self.configured:
            raise IntegrationNotConfiguredError(
                "Google",
                "Renseigne GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env "
                "(voir docs/google-setup.md).",
            )

    # -- etape 1: construire l'URL de consentement ---------------------------

    def build_authorization_url(self, scopes: list[str]) -> tuple[str, str]:
        """Retourne (url_de_consentement, state).

        Le verificateur PKCE reste cote serveur, indexe par `state`. Il ne
        transite jamais par le navigateur.
        """
        self._require_configuration()
        self._evict_stale()

        state = secrets.token_urlsafe(32)
        code_verifier = secrets.token_urlsafe(64)
        challenge = _b64url(hashlib.sha256(code_verifier.encode("ascii")).digest())
        self._pending[state] = _PendingAuthorization(code_verifier=code_verifier, scopes=scopes)

        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": " ".join(scopes),
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            # `offline` est ce qui declenche l'emission d'un refresh_token.
            "access_type": "offline",
            # `consent` garantit un refresh_token meme apres une autorisation
            # anterieure, sinon Google ne le renvoie qu'une seule fois.
            "prompt": "consent",
            "include_granted_scopes": "true",
        }
        return f"{AUTH_ENDPOINT}?{urlencode(params)}", state

    # -- etape 2: echanger le code contre un jeton ---------------------------

    async def exchange_code(self, *, code: str, state: str) -> OAuthToken:
        """Echange le code d'autorisation contre un jeton d'acces."""
        self._require_configuration()
        pending = self._pending.pop(state, None)
        if pending is None:
            raise IntegrationUnavailableError(
                "Google",
                "state inconnu ou deja utilise (tentative de rejeu, ou demande expiree)",
            )
        if pending.is_stale():
            raise IntegrationUnavailableError("Google", "demande d'autorisation expiree")

        payload = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "code_verifier": pending.code_verifier,
            "grant_type": "authorization_code",
            "redirect_uri": self.redirect_uri,
        }
        return await self._post_token(payload)

    # -- etape 3: rafraichir ------------------------------------------------

    async def refresh(self, refresh_token: str) -> OAuthToken:
        """Obtient un nouveau jeton d'acces a partir du jeton de rafraichissement."""
        self._require_configuration()
        if not refresh_token:
            raise IntegrationNotConfiguredError(
                "Google", "Aucun jeton de rafraichissement: reconnecte le compte."
            )
        payload = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
        return await self._post_token(payload)

    async def _post_token(self, payload: dict[str, str]) -> OAuthToken:
        try:
            response = await self._client.post(TOKEN_ENDPOINT, data=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text[:300]
            logger.warning("echec OAuth Google %s: %s", exc.response.status_code, detail)
            if exc.response.status_code in (400, 401):
                raise IntegrationNotConfiguredError(
                    "Google",
                    "L'autorisation a ete refusee ou revoquee. Reconnecte le compte.",
                ) from exc
            raise IntegrationUnavailableError("Google", detail) from exc
        except httpx.HTTPError as exc:
            raise IntegrationUnavailableError("Google", str(exc)) from exc

        data = response.json()
        expires_in = int(data.get("expires_in", 3600))
        return OAuthToken(
            access_token=data["access_token"],
            refresh_token=data.get("refresh_token", ""),
            token_type=data.get("token_type", "Bearer"),
            scopes=(data.get("scope") or "").split(),
            expires_at=datetime.now(UTC) + timedelta(seconds=expires_in),
        )

    # -- identite et revocation ---------------------------------------------

    async def fetch_account_email(self, access_token: str) -> str:
        """Recupere l'adresse du compte, pour l'afficher et indexer le jeton."""
        try:
            response = await self._client.get(
                USERINFO_ENDPOINT, headers={"Authorization": f"Bearer {access_token}"}
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("impossible de lire l'identite du compte Google: %s", exc)
            return ""
        return str(response.json().get("email", ""))

    async def revoke(self, token: str) -> bool:
        """Revoque un jeton cote Google. L'echec n'est pas bloquant."""
        try:
            response = await self._client.post(REVOKE_ENDPOINT, data={"token": token})
        except httpx.HTTPError as exc:
            logger.warning("revocation Google impossible: %s", exc)
            return False
        return response.status_code == 200

    def _evict_stale(self) -> None:
        for state in [s for s, p in self._pending.items() if p.is_stale()]:
            del self._pending[state]

    @property
    def pending_count(self) -> int:
        self._evict_stale()
        return len(self._pending)

    async def aclose(self) -> None:
        await self._client.aclose()
