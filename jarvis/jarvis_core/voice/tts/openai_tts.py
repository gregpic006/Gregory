"""Synthese vocale via l'API OpenAI (`/v1/audio/speech`)."""

from __future__ import annotations

import time

import httpx

from jarvis_core.errors import ConfigurationError, SpeechError
from jarvis_core.voice.tts.base import SpeechAudio, TextToSpeechProvider

API_URL = "https://api.openai.com/v1/audio/speech"


class OpenAITTSProvider(TextToSpeechProvider):
    name = "openai"

    def __init__(
        self,
        api_key: str,
        *,
        model: str = "gpt-4o-mini-tts",
        voice: str = "onyx",
        timeout: float = 30.0,
    ) -> None:
        if not api_key:
            raise ConfigurationError(
                "OPENAI_API_KEY est requise pour JARVIS_TTS_PROVIDER=openai."
            )
        self._api_key = api_key
        self._model = model
        self._voice = voice
        self._client = httpx.AsyncClient(timeout=timeout)
        self.available = True

    async def synthesize(self, text: str, *, voice: str | None = None) -> SpeechAudio | None:
        if not text.strip():
            return None
        started = time.perf_counter()
        try:
            response = await self._client.post(
                API_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={
                    "model": self._model,
                    "voice": voice or self._voice,
                    "input": text,
                    "response_format": "mp3",
                },
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise SpeechError(
                f"OpenAI TTS {exc.response.status_code}: {exc.response.text[:200]}",
                user_message="Le service de voix a refuse la requete.",
            ) from exc
        except httpx.HTTPError as exc:
            raise SpeechError(
                str(exc), user_message="Je n'arrive pas a joindre le service de voix."
            ) from exc

        return SpeechAudio(
            data=response.content,
            mime="audio/mpeg",
            provider=self.name,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    async def aclose(self) -> None:
        await self._client.aclose()
