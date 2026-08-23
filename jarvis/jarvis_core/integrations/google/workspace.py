"""Facade Google Workspace.

Un seul objet a cabler dans le runtime; il expose les trois services et le
cycle de vie de la connexion. Les outils ne connaissent que lui.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from jarvis_core.config import Settings
from jarvis_core.integrations.google.calendar import CalendarService
from jarvis_core.integrations.google.client import PROVIDER, GoogleClient
from jarvis_core.integrations.google.contacts import ContactsService
from jarvis_core.integrations.google.gmail import GmailService
from jarvis_core.integrations.google.oauth import GoogleOAuth, scopes_for
from jarvis_core.integrations.google.tokens import OAuthTokenRepository
from jarvis_core.persistence.db import Database
from jarvis_core.security.crypto import SecretBox

logger = logging.getLogger(__name__)


class GoogleWorkspace:
    """Point d'entree unique vers Gmail, Calendar et Contacts."""

    def __init__(
        self,
        *,
        settings: Settings,
        db: Database,
        secret_box: SecretBox,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self.tokens = OAuthTokenRepository(db, secret_box)
        self.oauth = GoogleOAuth(
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            redirect_uri=settings.google_callback_url,
            client=http,
        )
        self.client = GoogleClient(oauth=self.oauth, tokens=self.tokens, http=http)
        self.gmail = GmailService(self.client)
        self.calendar = CalendarService(self.client)
        self.contacts = ContactsService(self.client)

    # -- capacites -----------------------------------------------------------

    @property
    def configured(self) -> bool:
        """Vrai si les identifiants OAuth sont renseignes."""
        return self.oauth.configured

    @property
    def connected(self) -> bool:
        """Vrai si un compte a effectivement accorde l'acces."""
        return self.client.connected

    def requested_scopes(self) -> list[str]:
        """Portees a demander, deduites des capacites activees.

        Moindre privilege applique litteralement: si le calendrier est
        desactive, sa portee n'apparait meme pas sur l'ecran de consentement.
        """
        return scopes_for(
            gmail=self.settings.feature_gmail,
            # L'ecriture Gmail (brouillons, envoi) n'est demandee que si l'envoi
            # automatique ou les brouillons sont voulus.
            gmail_write=self.settings.feature_gmail,
            calendar=self.settings.feature_calendar,
            contacts=self.settings.feature_gmail or self.settings.feature_calendar,
        )

    def status(self) -> dict[str, Any]:
        """Etat expose a l'interface, sans aucun secret."""
        return {
            **self.client.status(),
            "requested_scopes": self.requested_scopes(),
            "redirect_uri": self.settings.google_callback_url,
            "features": {
                "gmail": self.settings.feature_gmail,
                "calendar": self.settings.feature_calendar,
            },
        }

    # -- cycle de vie de la connexion ----------------------------------------

    def start_connection(self) -> tuple[str, str]:
        """Retourne (url de consentement, state)."""
        return self.oauth.build_authorization_url(self.requested_scopes())

    async def complete_connection(self, *, code: str, state: str) -> dict[str, Any]:
        """Termine le flux et enregistre le jeton chiffre."""
        token = await self.oauth.exchange_code(code=code, state=state)
        account = await self.oauth.fetch_account_email(token.access_token)
        stored = self.tokens.save(
            provider=PROVIDER,
            account=account,
            access_token=token.access_token,
            refresh_token=token.refresh_token,
            token_type=token.token_type,
            scopes=token.scopes,
            expires_at=token.expires_at,
        )
        self.client.account = account
        if not token.refresh_token:
            logger.warning(
                "Google n'a pas renvoye de jeton de rafraichissement: la session "
                "expirera dans une heure sans possibilite de renouvellement."
            )
        logger.info("compte Google connecte: %s", account or "(adresse inconnue)")
        return stored.as_public_dict()

    async def disconnect(self, account: str | None = None) -> int:
        """Revoque cote Google puis supprime les jetons locaux."""
        token = self.tokens.get(PROVIDER, account)
        if token is not None and token.refresh_token:
            await self.oauth.revoke(token.refresh_token)
        removed = self.tokens.delete(PROVIDER, account)
        self.client.account = None
        return removed

    async def aclose(self) -> None:
        await self.oauth.aclose()
        await self.client.aclose()
