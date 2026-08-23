"""Tests du diagnostic Google.

Sa raison d'etre: repondre a « ca marche pas » par une cause precise. Chaque
test verifie qu'une panne donnee produit le bon diagnostic et la bonne
consigne, plutot qu'un echec generique.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from jarvis_core.config import Settings
from jarvis_core.diagnostics import FAIL, OK, WARN, check_google
from jarvis_core.integrations.google import GoogleWorkspace
from jarvis_core.integrations.google.client import PROVIDER
from jarvis_core.persistence.db import Database
from jarvis_core.security.crypto import SecretBox

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/contacts.readonly",
]


def _settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "JARVIS_DATABASE_URL": "sqlite:///:memory:",
        "JARVIS_TIMEZONE": "America/Montreal",
        "GOOGLE_CLIENT_ID": "cid",
        "GOOGLE_CLIENT_SECRET": "secret",
        "JARVIS_FEATURE_GMAIL": True,
        "JARVIS_FEATURE_CALENDAR": True,
    }
    base.update(overrides)
    return Settings(**base)


def _runtime(
    db: Database, settings: Settings, handler: Any, *, scopes: list[str] | None = None,
    connected: bool = True,
) -> Any:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    workspace = GoogleWorkspace(
        settings=settings, db=db, secret_box=SecretBox(SecretBox.generate_key()), http=http
    )
    if connected:
        workspace.tokens.save(
            provider=PROVIDER, account="greg@example.com", access_token="at",
            refresh_token="rt", token_type="Bearer",
            scopes=scopes if scopes is not None else SCOPES,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
    return SimpleNamespace(google=workspace, settings=settings)


def _by_name(results: list[Any], name: str) -> Any:
    return next(r for r in results if r.name.startswith(name))


def _everything_works(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    if "calendar" in url:
        return httpx.Response(200, json={"items": [
            {"id": "e1", "summary": "Comptable",
             "start": {"dateTime": "2026-08-24T08:30:00-04:00"},
             "end": {"dateTime": "2026-08-24T09:00:00-04:00"}}
        ]})
    if url.endswith("/messages") or "/messages?" in url:
        return httpx.Response(200, json={"messages": [{"id": "m1"}]})
    if "/messages/" in url:
        return httpx.Response(200, json={
            "id": "m1", "threadId": "t1",
            "payload": {"headers": [{"name": "Subject", "value": "Facture"}]},
        })
    if "people" in url:
        return httpx.Response(200, json={"results": [
            {"person": {"names": [{"displayName": "Xavier"}],
                        "emailAddresses": [{"value": "x@a.com"}]}}
        ]})
    return httpx.Response(200, json={})


async def test_everything_healthy_is_reported_as_such(db: Database) -> None:
    results = await check_google(_runtime(db, _settings(), _everything_works))
    assert all(r.status == OK for r in results), [
        (r.name, r.status, r.detail) for r in results if r.status != OK
    ]
    assert "1 evenement" in _by_name(results, "Calendar").detail
    assert "1 message" in _by_name(results, "Gmail").detail


async def test_missing_credentials_stop_immediately(db: Database) -> None:
    """Inutile de tester les API si les identifiants manquent."""
    settings = _settings(GOOGLE_CLIENT_ID="", GOOGLE_CLIENT_SECRET="")
    results = await check_google(_runtime(db, settings, _everything_works, connected=False))
    assert len(results) == 1
    assert results[0].status == FAIL
    assert "google-setup.md" in results[0].hint


async def test_disconnected_account_is_named(db: Database) -> None:
    results = await check_google(
        _runtime(db, _settings(), _everything_works, connected=False)
    )
    assert _by_name(results, "Compte connecte").status == FAIL
    assert "Connecter Google" in _by_name(results, "Compte connecte").hint


async def test_a_missing_permission_is_pinpointed(db: Database) -> None:
    """Cas reel: compte connecte avant l'activation du flag calendrier."""
    results = await check_google(
        _runtime(
            db, _settings(), _everything_works,
            scopes=["https://www.googleapis.com/auth/gmail.readonly"],
        )
    )
    calendar_permission = _by_name(results, "Permission")
    assert calendar_permission.status == FAIL
    assert "reconnecte" in calendar_permission.hint.lower()


async def test_api_failure_surfaces_the_real_cause(db: Database) -> None:
    def failing(request: httpx.Request) -> httpx.Response:
        if "calendar" in str(request.url):
            return httpx.Response(403, json={"error": {"status": "insufficientPermissions"}})
        return _everything_works(request)

    results = await check_google(_runtime(db, _settings(), failing))
    calendar = _by_name(results, "Calendar")
    assert calendar.status == FAIL
    assert "Permission manquante" in calendar.detail


async def test_contacts_failure_is_only_a_warning(db: Database) -> None:
    """People API oubliee: genant, pas bloquant. Le reste doit rester utilisable."""

    def no_people(request: httpx.Request) -> httpx.Response:
        if "people" in str(request.url):
            return httpx.Response(403, text="People API has not been used in project")
        return _everything_works(request)

    results = await check_google(_runtime(db, _settings(), no_people))
    contacts = _by_name(results, "Contacts")
    assert contacts.status == WARN
    assert _by_name(results, "Gmail").status == OK


async def test_unexpected_crash_is_captured_not_propagated(db: Database) -> None:
    """Le diagnostic doit survivre a n'importe quelle panne, y compris la mienne."""

    def exploding(request: httpx.Request) -> httpx.Response:
        raise RuntimeError("panne imprevue")

    results = await check_google(_runtime(db, _settings(), exploding))
    assert _by_name(results, "Calendar").status == FAIL


async def test_only_enabled_capabilities_are_tested(db: Database) -> None:
    settings = _settings(JARVIS_FEATURE_GMAIL=False)
    results = await check_google(_runtime(db, settings, _everything_works))
    names = [r.name for r in results]
    assert any(n.startswith("Calendar") for n in names)
    assert not any(n.startswith("Gmail") for n in names)


@pytest.mark.parametrize("flag", ["gmail", "calendar"])
def test_settings_expose_the_flags_the_diagnostic_reads(flag: str) -> None:
    assert flag in _settings().feature_map()
