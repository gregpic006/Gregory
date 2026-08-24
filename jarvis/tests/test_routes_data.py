"""Tests des donnees du centre de commande.

Ce que ces tests protegent: **une carte ne doit jamais montrer un chiffre
qu'on n'a pas**. Chaque volet porte un statut, et l'absence de source est
toujours dite, jamais remplacee par un zero ou une valeur plausible.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from jarvis_core.api.app import create_app
from jarvis_core.config import Settings
from jarvis_core.integrations.google.client import PROVIDER


def _settings(tmp_path: Any, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "JARVIS_LLM_PROVIDER": "mock",
        "JARVIS_USER_NAME": "Greg",
        "JARVIS_DATABASE_URL": f"sqlite:///{tmp_path}/data.db",
        "JARVIS_STT_PROVIDER": "null",
        "JARVIS_TTS_PROVIDER": "null",
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture()
def client(tmp_path: Any) -> Iterator[TestClient]:
    with TestClient(create_app(_settings(tmp_path))) as test_client:
        yield test_client


# =============================================================================
# Honnetete des volets
# =============================================================================


def test_absent_sources_are_declared_not_invented(client: TestClient) -> None:
    panes = client.get("/api/overview").json()["panes"]

    assert panes["today"]["status"] == "not_connected"
    assert panes["today"]["events"] == []
    assert "Calendar" in panes["today"]["detail"]

    assert panes["email"]["status"] == "not_connected"
    assert panes["email"]["messages"] == []
    assert "Gmail" in panes["email"]["detail"]

    assert panes["business"]["status"] == "not_connected"


def test_local_sources_are_connected_even_without_google(client: TestClient) -> None:
    """Rappels et memoire sont locaux: ils repondent toujours."""
    panes = client.get("/api/overview").json()["panes"]
    assert panes["tasks"]["status"] == "connected"
    assert panes["memory"]["status"] == "connected"


def test_reminders_appear_in_the_overview(client: TestClient) -> None:
    client.post(
        "/api/chat",
        json={"text": "rappelle-moi d appeler mon comptable demain matin", "session_id": "s"},
    )
    tasks = client.get("/api/overview").json()["panes"]["tasks"]
    assert tasks["status"] == "connected"
    assert any("comptable" in reminder["text"] for reminder in tasks["reminders"])


def test_google_failure_is_an_error_not_an_empty_list(tmp_path: Any) -> None:
    """Une panne d'API doit se distinguer d'une absence de rendez-vous.

    C'est la difference entre « tu n'as rien demain » et « je n'ai pas pu
    regarder » — la premiere phrase serait un mensonge.
    """
    settings = _settings(
        tmp_path,
        JARVIS_FEATURE_CALENDAR=True,
        JARVIS_FEATURE_GMAIL=True,
        GOOGLE_CLIENT_ID="cid",
        GOOGLE_CLIENT_SECRET="secret",
    )
    app = create_app(settings)
    with TestClient(app) as client:
        runtime = app.state.runtime
        # Compte connecte, mais l'API repond 500.
        runtime.google.tokens.save(
            provider=PROVIDER, account="greg@example.com", access_token="at",
            refresh_token="rt", token_type="Bearer",
            scopes=[
                "https://www.googleapis.com/auth/calendar.events",
                "https://www.googleapis.com/auth/gmail.readonly",
            ],
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
        runtime.google.client._http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(500, text="boom"))
        )
        panes = client.get("/api/overview").json()["panes"]

    assert panes["today"]["status"] == "error"
    assert panes["today"]["events"] == []
    assert panes["email"]["status"] == "error"


def test_disconnected_google_is_reported_as_such(tmp_path: Any) -> None:
    settings = _settings(tmp_path, JARVIS_FEATURE_CALENDAR=True)
    with TestClient(create_app(settings)) as client:
        today = client.get("/api/overview").json()["panes"]["today"]
    assert today["status"] == "not_connected"
    assert "Aucun compte Google" in today["detail"]


# =============================================================================
# Entreprises
# =============================================================================


def test_business_metrics_carry_no_invented_value(client: TestClient) -> None:
    payload = client.get("/api/businesses").json()
    names = {org["name"] for org in payload["organizations"]}
    assert {"Grande Allee", "Maguire", "Bouvier", "Portail"} <= names

    for org in payload["organizations"]:
        assert org["metrics"], f"{org['name']} devrait declarer ses indicateurs"
        for metric in org["metrics"]:
            assert metric["status"] == "not_connected"
            assert metric["value"] is None, "aucune valeur ne doit etre fabriquee"


def test_personal_organization_is_not_a_business(client: TestClient) -> None:
    payload = client.get("/api/businesses").json()
    assert all(org["id"] != "PERSONAL" for org in payload["organizations"])


# =============================================================================
# Memoire
# =============================================================================


def test_memory_is_listed_with_its_sources(client: TestClient) -> None:
    client.post(
        "/api/chat",
        json={"text": "retiens que Xavier est mon associe dans Portail", "session_id": "s"},
    )
    payload = client.get("/api/memory").json()
    assert payload["enabled"] is True
    assert payload["memories"], "le souvenir doit apparaitre"
    assert all(memory["source"] for memory in payload["memories"]), "source obligatoire"


def test_memory_can_be_searched_and_forgotten(client: TestClient) -> None:
    client.post(
        "/api/chat",
        json={"text": "retiens que Xavier est mon associe dans Portail", "session_id": "s"},
    )
    found = client.get("/api/memory", params={"query": "Xavier"}).json()["memories"]
    assert found

    memory_id = found[0]["id"]
    assert client.delete(f"/api/memory/{memory_id}").status_code == 200
    assert client.delete(f"/api/memory/{memory_id}").status_code == 404


def test_memory_disabled_is_stated_not_faked(tmp_path: Any) -> None:
    settings = _settings(tmp_path, JARVIS_FEATURE_PERSISTENT_MEMORY=False)
    with TestClient(create_app(settings)) as client:
        payload = client.get("/api/memory").json()
        assert payload["enabled"] is False
        assert payload["memories"] == []
        assert client.delete("/api/memory/whatever").status_code == 400


# =============================================================================
# L'interface compilee est bien servie
# =============================================================================


def test_api_routes_win_over_the_static_mount(client: TestClient) -> None:
    """Le montage de l'interface a la racine ne doit pas masquer l'API."""
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/system").status_code == 200
    assert client.get("/api/overview").status_code == 200
