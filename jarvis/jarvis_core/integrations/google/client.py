"""Client HTTP authentifie pour les API Google.

Il porte trois responsabilites, et rien d'autre:

* attacher le jeton d'acces;
* le rafraichir quand il expire — y compris lorsque Google repond 401 alors
  que l'expiration locale semblait encore valide (horloges desynchronisees,
  revocation cote Google);
* traduire les erreurs HTTP en erreurs JARVIS explicites, pour qu'aucune
  panne ne se transforme en reponse inventee.

Les services metier (Gmail, Calendar, Contacts) ne connaissent que ce client.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from jarvis_core.errors import IntegrationNotConfiguredError, IntegrationUnavailableError
from jarvis_core.integrations.google.oauth import GoogleOAuth
from jarvis_core.integrations.google.tokens import OAuthTokenRepository, StoredToken

logger = logging.getLogger(__name__)

PROVIDER = "google"


class GoogleClient:
    """Effectue les appels API pour le compte connecte."""

    def __init__(
        self,
        *,
        oauth: GoogleOAuth,
        tokens: OAuthTokenRepository,
        http: httpx.AsyncClient | None = None,
        account: str | None = None,
    ) -> None:
        self.oauth = oauth
        self.tokens = tokens
        self.account = account
        self._http = http or httpx.AsyncClient(timeout=25.0)
        self._refresh_lock = asyncio.Lock()

    # -- etat ----------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self.tokens.get(PROVIDER, self.account) is not None

    def status(self) -> dict[str, Any]:
        """Etat de la connexion, expose a l'interface. Sans aucun secret."""
        token = self.tokens.get(PROVIDER, self.account)
        if token is None:
            return {
                "connected": False,
                "configured": self.oauth.configured,
                "accounts": [],
            }
        return {
            "connected": True,
            "configured": self.oauth.configured,
            "accounts": self.tokens.list_accounts(PROVIDER),
            **token.as_public_dict(),
        }

    def require_scope(self, scope: str, capability: str) -> None:
        """Verifie qu'une portee a bien ete accordee avant d'agir."""
        token = self._stored_token()
        if not token.has_scope(scope):
            raise IntegrationNotConfiguredError(
                "Google",
                f"L'autorisation « {capability} » n'a pas ete accordee. "
                "Reconnecte le compte en acceptant cette permission.",
            )

    def _stored_token(self) -> StoredToken:
        token = self.tokens.get(PROVIDER, self.account)
        if token is None:
            raise IntegrationNotConfiguredError(
                "Google",
                "Aucun compte Google connecte. Lance la connexion depuis l'interface.",
            )
        return token

    # -- jeton ---------------------------------------------------------------

    async def _access_token(self, *, force_refresh: bool = False) -> str:
        token = self._stored_token()
        if not force_refresh and not token.is_expired():
            return token.access_token

        async with self._refresh_lock:
            # Une autre coroutine a pu rafraichir pendant l'attente du verrou.
            token = self._stored_token()
            if not force_refresh and not token.is_expired():
                return token.access_token

            logger.info("rafraichissement du jeton Google (%s)", token.account or "compte unique")
            refreshed = await self.oauth.refresh(token.refresh_token)
            self.tokens.save(
                provider=PROVIDER,
                account=token.account,
                access_token=refreshed.access_token,
                refresh_token=refreshed.refresh_token,
                token_type=refreshed.token_type,
                # Un rafraichissement ne renvoie pas toujours la liste des
                # portees: on conserve celles deja accordees.
                scopes=refreshed.scopes or token.scopes,
                expires_at=refreshed.expires_at,
            )
            return refreshed.access_token

    # -- requetes ------------------------------------------------------------

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Appelle une API Google et retourne le JSON decode.

        Un 401 declenche un unique rafraichissement puis un seul reessai: si le
        second echoue, c'est que le consentement a ete revoque.
        """
        access_token = await self._access_token()
        response = await self._send(method, url, access_token, params, json_body)

        if response.status_code == 401:
            logger.info("401 Google: rafraichissement force puis reessai unique")
            access_token = await self._access_token(force_refresh=True)
            response = await self._send(method, url, access_token, params, json_body)

        return self._handle(response, url)

    async def download(
        self, url: str, *, params: dict[str, Any] | None = None, max_bytes: int = 0
    ) -> bytes:
        """Telecharge un contenu binaire (export Drive, piece jointe).

        Meme contrat que `request` pour le 401: un seul rafraichissement, un
        seul reessai. `max_bytes` refuse un fichier demesure plutot que de le
        charger entierement en memoire.
        """
        access_token = await self._access_token()
        response = await self._send("GET", url, access_token, params, None)
        if response.status_code == 401:
            access_token = await self._access_token(force_refresh=True)
            response = await self._send("GET", url, access_token, params, None)

        if response.status_code >= 400:
            # Reutilise la traduction d'erreurs commune (401, 403, 429...).
            self._handle(response, url)

        content = response.content
        if max_bytes and len(content) > max_bytes:
            raise IntegrationUnavailableError(
                "Google",
                f"fichier trop volumineux ({len(content)} octets) sur {url}",
            )
        return content

    async def upload(
        self,
        url: str,
        content: bytes,
        *,
        content_type: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Depose un contenu binaire (creation de fichier Drive).

        Distinct de `request`, qui envoie du JSON, et de `download`, qui lit.
        Meme contrat que les deux pour le 401: un seul rafraichissement, un
        seul reessai.
        """
        access_token = await self._access_token()
        response = await self._send_bytes(url, access_token, content, content_type, params)
        if response.status_code == 401:
            access_token = await self._access_token(force_refresh=True)
            response = await self._send_bytes(url, access_token, content, content_type, params)
        return self._handle(response, url)

    async def _send_bytes(
        self,
        url: str,
        access_token: str,
        content: bytes,
        content_type: str,
        params: dict[str, Any] | None,
    ) -> httpx.Response:
        try:
            return await self._http.request(
                "PATCH",
                url,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": content_type,
                },
                params=params,
                content=content,
            )
        except httpx.HTTPError as exc:
            raise IntegrationUnavailableError("Google", str(exc)) from exc

    async def _send(
        self,
        method: str,
        url: str,
        access_token: str,
        params: dict[str, Any] | None,
        json_body: dict[str, Any] | None,
    ) -> httpx.Response:
        try:
            return await self._http.request(
                method,
                url,
                headers={"Authorization": f"Bearer {access_token}"},
                params=params,
                json=json_body,
            )
        except httpx.HTTPError as exc:
            raise IntegrationUnavailableError("Google", str(exc)) from exc

    @staticmethod
    def _handle(response: httpx.Response, url: str) -> dict[str, Any]:
        if response.status_code == 401:
            raise IntegrationNotConfiguredError(
                "Google", "L'acces a ete revoque. Reconnecte le compte."
            )
        if response.status_code == 403:
            detail = response.text[:300]
            if "insufficientPermissions" in detail or "ACCESS_TOKEN_SCOPE" in detail:
                raise IntegrationNotConfiguredError(
                    "Google",
                    "Permission manquante pour cette action. Reconnecte le compte "
                    "en acceptant l'autorisation demandee.",
                )
            raise IntegrationUnavailableError("Google", f"403 sur {url}: {detail}")
        if response.status_code == 429:
            raise IntegrationUnavailableError(
                "Google", "quota atteint (429), reessayer plus tard"
            )
        if response.status_code >= 400:
            raise IntegrationUnavailableError(
                "Google", f"{response.status_code} sur {url}: {response.text[:300]}"
            )
        if not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise IntegrationUnavailableError("Google", "reponse illisible") from exc
        return payload if isinstance(payload, dict) else {"items": payload}

    async def aclose(self) -> None:
        await self._http.aclose()
