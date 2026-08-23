"""Tests de l'API HTTP."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from jarvis_core.api.app import create_app
from jarvis_core.config import Settings


@pytest.fixture()
def client(tmp_path) -> Iterator[TestClient]:  # type: ignore[no-untyped-def]
    settings = Settings(
        JARVIS_NAME="Jarvis",
        JARVIS_USER_NAME="Greg",
        JARVIS_ENV="development",
        JARVIS_LLM_PROVIDER="mock",
        JARVIS_DATABASE_URL=f"sqlite:///{tmp_path}/test.db",
        JARVIS_STT_PROVIDER="null",
        JARVIS_TTS_PROVIDER="null",
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_system_exposes_providers_and_tools(client: TestClient) -> None:
    payload = client.get("/api/system").json()
    assert payload["providers"]["llm"] == "mock"
    assert payload["providers"]["stt_available"] is False
    names = {tool["name"] for tool in payload["tools"]}
    assert "get_current_time" in names
    gmail_tool = next(tool for tool in payload["tools"] if tool["name"] == "search_email")
    assert gmail_tool["available"] is False


def test_text_chat_round_trip(client: TestClient) -> None:
    response = client.post("/api/chat", json={"text": "Bon matin Jarvis"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["text"]
    assert payload["session_id"]


def test_session_is_continuous(client: TestClient) -> None:
    first = client.post("/api/chat", json={"text": "Bon matin"}).json()
    session_id = first["session_id"]
    client.post("/api/chat", json={"text": "quelle heure est-il?", "session_id": session_id})
    state = client.get(f"/api/session/{session_id}").json()
    assert len(state["history"]) >= 3


def test_transcription_without_provider_is_explicit(client: TestClient) -> None:
    response = client.post(
        "/api/voice/transcribe", files={"audio": ("a.webm", b"fake", "audio/webm")}
    )
    assert response.status_code == 400
    assert "reconnaissance vocale" in response.json()["error"]


def test_speak_without_provider_returns_no_content(client: TestClient) -> None:
    response = client.post("/api/voice/speak", json={"text": "Bonsoir."})
    assert response.status_code == 204


def test_audit_trail_records_tool_calls(client: TestClient) -> None:
    client.post("/api/chat", json={"text": "quelle heure est-il?"})
    entries = client.get("/api/audit").json()["entries"]
    assert any(entry["tool"] == "get_current_time" for entry in entries)


def test_metrics_are_exposed(client: TestClient) -> None:
    client.post("/api/chat", json={"text": "Bonsoir"})
    payload = client.get("/api/metrics").json()
    assert payload["turns"] >= 1
    assert "latency_ms" in payload


def test_websocket_conversation(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "state"
        assert "system" in hello

        ws.send_json({"type": "text", "text": "Bon matin Jarvis"})
        kinds: list[str] = []
        for _ in range(12):
            event = ws.receive_json()
            kinds.append(event["type"])
            if event["type"] == "message":
                assert event["text"]
                break
        assert "transcript" in kinds
        assert "message" in kinds
