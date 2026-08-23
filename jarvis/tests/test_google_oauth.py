"""Tests du flux OAuth Google et du stockage des jetons.

Ce que ces tests protegent concretement:
* le mot de passe Google n'est jamais demande — seul un code d'autorisation
  circule, et uniquement par la boucle locale;
* un code intercepte n'est pas rejouable (PKCE + state a usage unique);
* les jetons ne sont jamais ecrits en clair dans la base;
* un jeton expire est renouvele sans intervention, et une revocation cote
  Google produit un message clair au lieu d'une reponse inventee.
"""

from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from jarvis_core.errors import IntegrationNotConfiguredError, IntegrationUnavailableError
from jarvis_core.integrations.google.client import PROVIDER, GoogleClient
from jarvis_core.integrations.google.oauth import GoogleOAuth, scopes_for
from jarvis_core.integrations.google.tokens import OAuthTokenRepository
from jarvis_core.persistence.db import Database
from jarvis_core.security.crypto import SecretBox

TOKEN_URL = "https://oauth2.googleapis.com/token"


@pytest.fixture()
def box() -> SecretBox:
    return SecretBox(SecretBox.generate_key())


@pytest.fixture()
def tokens(db: Database, box: SecretBox) -> OAuthTokenRepository:
    return OAuthTokenRepository(db, box)


def _transport(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# =============================================================================
# Portees: moindre privilege
# =============================================================================


def test_only_enabled_capabilities_are_requested() -> None:
    """Calendrier desactive: sa permission n'apparait meme pas au consentement."""
    scopes = scopes_for(gmail=True, gmail_write=False, calendar=False, contacts=False)
    assert "https://www.googleapis.com/auth/gmail.readonly" in scopes
    assert not any("calendar" in s for s in scopes)
    assert not any("gmail.compose" in s for s in scopes)


def test_write_scope_is_separate_from_read() -> None:
    read_only = scopes_for(gmail=True, gmail_write=False, calendar=False, contacts=False)
    with_write = scopes_for(gmail=True, gmail_write=True, calendar=False, contacts=False)
    assert "https://www.googleapis.com/auth/gmail.compose" not in read_only
    assert "https://www.googleapis.com/auth/gmail.compose" in with_write


def test_no_full_mailbox_scope_is_ever_requested() -> None:
    """`https://mail.google.com/` donne un acces total: on ne le demande jamais."""
    scopes = scopes_for(gmail=True, gmail_write=True, calendar=True, contacts=True)
    assert "https://mail.google.com/" not in scopes
    assert "https://www.googleapis.com/auth/gmail.modify" not in scopes


# =============================================================================
# Flux d'autorisation
# =============================================================================


def _oauth(client: httpx.AsyncClient | None = None) -> GoogleOAuth:
    return GoogleOAuth(
        client_id="cid.apps.googleusercontent.com",
        client_secret="secret",
        redirect_uri="http://127.0.0.1:8787/api/integrations/google/callback",
        client=client,
    )


def test_authorization_url_carries_pkce_and_state() -> None:
    oauth = _oauth()
    url, state = oauth.build_authorization_url(["openid", "email"])
    params = parse_qs(urlparse(url).query)

    assert params["code_challenge_method"] == ["S256"]
    assert params["state"] == [state]
    assert params["access_type"] == ["offline"]
    assert params["prompt"] == ["consent"]
    assert params["response_type"] == ["code"]
    # Le verificateur ne doit jamais apparaitre dans l'URL du navigateur.
    assert "code_verifier" not in params


def test_each_authorization_uses_a_fresh_state() -> None:
    oauth = _oauth()
    _, first = oauth.build_authorization_url(["openid"])
    _, second = oauth.build_authorization_url(["openid"])
    assert first != second


async def test_exchange_sends_the_matching_verifier() -> None:
    """Le defi PKCE de l'URL doit correspondre au verificateur envoye ensuite."""
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update({k: v[0] for k, v in parse_qs(request.content.decode()).items()})
        return httpx.Response(
            200,
            json={
                "access_token": "at-1",
                "refresh_token": "rt-1",
                "expires_in": 3599,
                "scope": "openid email",
                "token_type": "Bearer",
            },
        )

    oauth = _oauth(_transport(handler))
    url, state = oauth.build_authorization_url(["openid", "email"])
    challenge = parse_qs(urlparse(url).query)["code_challenge"][0]

    token = await oauth.exchange_code(code="auth-code", state=state)

    verifier = captured["code_verifier"]
    recomputed = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    assert recomputed == challenge
    assert captured["grant_type"] == "authorization_code"
    assert token.access_token == "at-1"
    assert token.refresh_token == "rt-1"


async def test_unknown_state_is_refused() -> None:
    """Protection CSRF: un retour dont le state est inconnu est rejete."""
    oauth = _oauth(_transport(lambda r: httpx.Response(200, json={})))
    with pytest.raises(IntegrationUnavailableError):
        await oauth.exchange_code(code="x", state="state-fabrique")


async def test_a_state_cannot_be_replayed() -> None:
    """Un code intercepte et rejoue ne passe pas deux fois."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "at", "expires_in": 60})

    oauth = _oauth(_transport(handler))
    _, state = oauth.build_authorization_url(["openid"])
    await oauth.exchange_code(code="c", state=state)
    with pytest.raises(IntegrationUnavailableError):
        await oauth.exchange_code(code="c", state=state)


async def test_revoked_consent_gives_an_actionable_message() -> None:
    oauth = _oauth(_transport(lambda r: httpx.Response(400, json={"error": "invalid_grant"})))
    with pytest.raises(IntegrationNotConfiguredError) as excinfo:
        await oauth.refresh("rt-perime")
    assert "Reconnecte" in excinfo.value.user_message


def test_unconfigured_oauth_refuses_instead_of_pretending() -> None:
    oauth = GoogleOAuth(client_id="", client_secret="", redirect_uri="http://x")
    assert not oauth.configured
    with pytest.raises(IntegrationNotConfiguredError):
        oauth.build_authorization_url(["openid"])


# =============================================================================
# Stockage des jetons
# =============================================================================


def test_tokens_are_encrypted_at_rest(tokens: OAuthTokenRepository, db: Database) -> None:
    tokens.save(
        provider=PROVIDER,
        account="greg@example.com",
        access_token="ACCESS-EN-CLAIR",
        refresh_token="REFRESH-EN-CLAIR",
        token_type="Bearer",
        scopes=["openid"],
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    raw = str(dict(db.query_one("SELECT * FROM oauth_tokens")))  # type: ignore[arg-type]
    assert "ACCESS-EN-CLAIR" not in raw
    assert "REFRESH-EN-CLAIR" not in raw
    # ...mais restent lisibles par l'application.
    stored = tokens.get(PROVIDER, "greg@example.com")
    assert stored is not None
    assert stored.access_token == "ACCESS-EN-CLAIR"


def test_refresh_token_survives_a_renewal_without_one(
    tokens: OAuthTokenRepository,
) -> None:
    """Google n'emet le jeton de rafraichissement qu'une fois: on le conserve."""
    expires = datetime.now(UTC) + timedelta(hours=1)
    tokens.save(
        provider=PROVIDER, account="greg@example.com", access_token="a1",
        refresh_token="rt-unique", token_type="Bearer", scopes=["openid"], expires_at=expires,
    )
    tokens.save(
        provider=PROVIDER, account="greg@example.com", access_token="a2",
        refresh_token="", token_type="Bearer", scopes=["openid"], expires_at=expires,
    )
    stored = tokens.get(PROVIDER, "greg@example.com")
    assert stored is not None
    assert stored.refresh_token == "rt-unique"
    assert stored.access_token == "a2"


def test_expiry_uses_a_safety_margin(tokens: OAuthTokenRepository) -> None:
    """Un jeton qui expire dans 10 s est deja considere perime."""
    stored = tokens.save(
        provider=PROVIDER, account="a@b.c", access_token="a", refresh_token="r",
        token_type="Bearer", scopes=[],
        expires_at=datetime.now(UTC) + timedelta(seconds=10),
    )
    assert stored.is_expired()
    assert not stored.is_expired(leeway_seconds=0)


def test_public_view_never_leaks_a_secret(tokens: OAuthTokenRepository) -> None:
    stored = tokens.save(
        provider=PROVIDER, account="a@b.c", access_token="SECRET-A", refresh_token="SECRET-R",
        token_type="Bearer", scopes=["openid"],
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    public = json.dumps(stored.as_public_dict())
    assert "SECRET-A" not in public and "SECRET-R" not in public


def test_disconnect_removes_the_tokens(tokens: OAuthTokenRepository) -> None:
    tokens.save(
        provider=PROVIDER, account="a@b.c", access_token="a", refresh_token="r",
        token_type="Bearer", scopes=[], expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    assert tokens.delete(PROVIDER) == 1
    assert tokens.get(PROVIDER) is None


# =============================================================================
# Client: rafraichissement et erreurs
# =============================================================================


def _seed(tokens: OAuthTokenRepository, *, expires_in: int, scopes: list[str]) -> None:
    tokens.save(
        provider=PROVIDER,
        account="greg@example.com",
        access_token="at-vieux",
        refresh_token="rt-1",
        token_type="Bearer",
        scopes=scopes,
        expires_at=datetime.now(UTC) + timedelta(seconds=expires_in),
    )


async def test_expired_token_is_refreshed_transparently(
    tokens: OAuthTokenRepository,
) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if str(request.url) == TOKEN_URL:
            return httpx.Response(
                200, json={"access_token": "at-neuf", "expires_in": 3600, "scope": "openid"}
            )
        assert request.headers["Authorization"] == "Bearer at-neuf"
        return httpx.Response(200, json={"ok": True})

    _seed(tokens, expires_in=-10, scopes=["openid"])
    http = _transport(handler)
    client = GoogleClient(oauth=_oauth(http), tokens=tokens, http=http)

    assert await client.request("GET", "https://example.test/api") == {"ok": True}
    assert calls[0] == TOKEN_URL
    # Le nouveau jeton est persiste: le prochain appel n'exige plus de renouvellement.
    stored = tokens.get(PROVIDER)
    assert stored is not None and stored.access_token == "at-neuf"


async def test_a_401_triggers_exactly_one_retry(tokens: OAuthTokenRepository) -> None:
    """Horloge desynchronisee ou revocation: on retente une fois, pas en boucle."""
    api_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal api_calls
        if str(request.url) == TOKEN_URL:
            return httpx.Response(
                200, json={"access_token": "at-2", "expires_in": 3600, "scope": "openid"}
            )
        api_calls += 1
        return httpx.Response(401, json={"error": "invalid"})

    _seed(tokens, expires_in=3600, scopes=["openid"])
    http = _transport(handler)
    client = GoogleClient(oauth=_oauth(http), tokens=tokens, http=http)

    with pytest.raises(IntegrationNotConfiguredError):
        await client.request("GET", "https://example.test/api")
    assert api_calls == 2, "un seul reessai, sinon on boucle sur une revocation"


async def test_missing_permission_is_named_clearly(tokens: OAuthTokenRepository) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"status": "insufficientPermissions"}})

    _seed(tokens, expires_in=3600, scopes=["openid"])
    http = _transport(handler)
    client = GoogleClient(oauth=_oauth(http), tokens=tokens, http=http)

    with pytest.raises(IntegrationNotConfiguredError) as excinfo:
        await client.request("GET", "https://example.test/api")
    assert "Permission manquante" in excinfo.value.user_message


async def test_quota_is_reported_as_unavailable(tokens: OAuthTokenRepository) -> None:
    _seed(tokens, expires_in=3600, scopes=["openid"])
    http = _transport(lambda r: httpx.Response(429, text="rate limited"))
    client = GoogleClient(oauth=_oauth(http), tokens=tokens, http=http)

    with pytest.raises(IntegrationUnavailableError) as excinfo:
        await client.request("GET", "https://example.test/api")
    assert "Je n'arrive pas a joindre Google" in excinfo.value.user_message


async def test_scope_is_checked_before_acting(tokens: OAuthTokenRepository) -> None:
    """On refuse localement plutot que d'envoyer une requete vouee au 403."""
    _seed(tokens, expires_in=3600, scopes=["openid"])
    http = _transport(lambda r: httpx.Response(200, json={}))
    client = GoogleClient(oauth=_oauth(http), tokens=tokens, http=http)

    with pytest.raises(IntegrationNotConfiguredError) as excinfo:
        client.require_scope(
            "https://www.googleapis.com/auth/gmail.readonly", "lire tes courriels"
        )
    assert "lire tes courriels" in excinfo.value.user_message


def test_no_account_is_reported_not_guessed(tokens: OAuthTokenRepository) -> None:
    http = _transport(lambda r: httpx.Response(200, json={}))
    client = GoogleClient(oauth=_oauth(http), tokens=tokens, http=http)
    assert not client.connected
    assert client.status()["connected"] is False
