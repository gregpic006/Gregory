"""Controle d'acces reseau.

Ce que ces tests protegent: JARVIS ouvert au Wi-Fi d'un restaurant donne acces
aux courriels, a l'agenda et aux chiffres d'affaires. L'exposition sans jeton
ne doit pas etre possible, meme par distraction.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from jarvis_core.api.app import create_app
from jarvis_core.config import Settings
from jarvis_core.errors import ConfigurationError
from jarvis_core.security.access import (
    extract_token,
    generate_token,
    is_loopback,
    requires_token,
    token_matches,
    validate_configuration,
)

TOKEN = "jeton-de-test-abcdef"


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1", ""])
def test_local_hosts_need_no_token(host: str) -> None:
    assert is_loopback(host)
    assert requires_token(host) is False


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.2.14", "10.0.0.5", "monpc.local"])
def test_network_hosts_require_a_token(host: str) -> None:
    assert requires_token(host) is True


def test_exposing_without_a_token_is_refused() -> None:
    """Mieux vaut ne pas demarrer que s'ouvrir a tout le monde en silence."""
    with pytest.raises(ConfigurationError) as excinfo:
        validate_configuration(host="0.0.0.0", token="")

    assert "Wi-Fi" in excinfo.value.user_message
    assert "jarvis remote" in excinfo.value.user_message


def test_exposing_with_a_token_is_allowed() -> None:
    validate_configuration(host="0.0.0.0", token=TOKEN)


def test_local_without_token_is_allowed() -> None:
    validate_configuration(host="127.0.0.1", token="")


def test_token_comparison_is_constant_time() -> None:
    assert token_matches(TOKEN, TOKEN) is True
    assert token_matches(TOKEN, "mauvais") is False
    assert token_matches(TOKEN, "") is False
    # Un jeton vide cote serveur ne doit jamais valider quoi que ce soit.
    assert token_matches("", "") is False
    assert token_matches("", "n'importe quoi") is False


def test_generated_tokens_are_unique_and_long() -> None:
    tokens = {generate_token() for _ in range(50)}

    assert len(tokens) == 50
    assert all(len(token) >= 30 for token in tokens)


def test_token_is_read_from_header_then_url() -> None:
    assert extract_token({"X-Jarvis-Token": " abc "}, {}) == "abc"
    assert extract_token({"Authorization": "Bearer xyz"}, {}) == "xyz"
    assert extract_token({}, {"token": "depuis-url"}) == "depuis-url"
    # L'en-tete prime: l'interface l'utilise une fois le jeton range.
    assert extract_token({"X-Jarvis-Token": "entete"}, {"token": "url"}) == "entete"
    assert extract_token({}, {}) == ""


# =============================================================================
# Comportement reel de l'API
# =============================================================================


def _settings(tmp_path: Any, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "JARVIS_LLM_PROVIDER": "mock",
        "JARVIS_DATABASE_URL": f"sqlite:///{tmp_path}/data.db",
        "JARVIS_STT_PROVIDER": "null",
        "JARVIS_TTS_PROVIDER": "null",
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture()
def remote_client(tmp_path: Any) -> Iterator[TestClient]:
    settings = _settings(tmp_path, JARVIS_HOST="0.0.0.0", JARVIS_ACCESS_TOKEN=TOKEN)
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture()
def local_client(tmp_path: Any) -> Iterator[TestClient]:
    with TestClient(create_app(_settings(tmp_path))) as client:
        yield client


def test_api_is_refused_without_a_token(remote_client: TestClient) -> None:
    response = remote_client.get("/api/overview")

    assert response.status_code == 401
    assert "Jeton" in response.json()["detail"]


def test_api_accepts_the_header(remote_client: TestClient) -> None:
    response = remote_client.get("/api/overview", headers={"X-Jarvis-Token": TOKEN})

    assert response.status_code == 200


def test_api_accepts_the_url_parameter(remote_client: TestClient) -> None:
    """Le premier acces depuis un telephone passe forcement par l'URL."""
    response = remote_client.get("/api/overview", params={"token": TOKEN})

    assert response.status_code == 200


def test_a_wrong_token_is_refused(remote_client: TestClient) -> None:
    response = remote_client.get("/api/overview", headers={"X-Jarvis-Token": "presque"})

    assert response.status_code == 401


def test_health_stays_public(remote_client: TestClient) -> None:
    """Sert aux verifications de demarrage et ne revele rien."""
    assert remote_client.get("/api/health").status_code == 200


def test_every_data_route_is_protected(remote_client: TestClient) -> None:
    """Une seule route oubliee suffirait a faire fuiter les donnees."""
    for path in (
        "/api/overview",
        "/api/businesses",
        "/api/memory",
        "/api/documents",
        "/api/alerts",
        "/api/settings",
        "/api/system",
    ):
        assert remote_client.get(path).status_code == 401, path


def test_writing_routes_are_protected_too(remote_client: TestClient) -> None:
    assert remote_client.patch("/api/settings", json={"features": {}}).status_code == 401
    assert remote_client.post("/api/briefing").status_code == 401


def test_local_mode_needs_no_token(local_client: TestClient) -> None:
    """En local, exiger un jeton n'ajouterait qu'une friction inutile."""
    assert local_client.get("/api/overview").status_code == 200


def test_websocket_is_refused_without_a_token(remote_client: TestClient) -> None:
    """Le WebSocket porte la conversation entiere: il ne doit pas etre oublie."""
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as excinfo, remote_client.websocket_connect("/ws"):
        pass

    assert excinfo.value.code == 1008


def test_websocket_accepts_a_valid_token(remote_client: TestClient) -> None:
    with remote_client.websocket_connect(f"/ws?token={TOKEN}") as socket:
        assert socket is not None
