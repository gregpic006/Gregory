"""Schemas d'entree/sortie de l'API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    """Un tour de conversation en mode texte."""

    text: str = Field(min_length=1, max_length=8000)
    session_id: str | None = None
    organization: str | None = None


class ConfirmRequest(BaseModel):
    """Reponse a une demande de confirmation."""

    session_id: str
    action_id: str
    approved: bool


class SpeakRequest(BaseModel):
    """Demande de synthese vocale."""

    text: str = Field(min_length=1, max_length=5000)
    voice: str | None = None


class TurnResponse(BaseModel):
    """Reponse complete d'un tour."""

    text: str
    session_id: str
    citations: list[dict[str, Any]] = []
    tools: list[dict[str, Any]] = []
    pending_confirmation: dict[str, Any] | None = None
    latency_ms: int = 0
    model: str = ""
    error: str = ""
