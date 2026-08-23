"""Synthese vocale ElevenLabs.

Choisi pour la qualite de voix et la latence du modele `turbo`, qui supporte le
francais.  L'identifiant de voix est configurable: c'est la que se choisit le
timbre "calme, masculin, intelligent".
"""

from __future__ import annotations

import time

import httpx

from jarvis_core.errors import ConfigurationError, SpeechError
from jarvis_core.voice.tts.base import SpeechAudio, TextToSpeechProvider

API_BASE = "https://api.elevenlabs.io/v1/text-to-speech"


class ElevenLabsTTSProvider(TextToSpeechProvider):
    name = "elevenlabs"

    def __init__(
        self,
        api_key: str,
        *,
        voice_id: str,
        model: str = "eleven_turbo_v2_5",
        timeout: float = 30.0,
    ) -> None:
        if not api_key:
            raise ConfigurationError(
                "ELEVENLABS_API_KEY est requise pour JARVIS_TTS_PROVIDER=elevenlabs."
            )
        if not voice_id:
            raise ConfigurationError(
                "JARVIS_TTS_ELEVENLABS_VOICE_ID est requis: choisis une voix dans ton compte."
            )
        self._api_key = api_key
        self._voice_id = voice_id
        self._model = model
        self._client = httpx.AsyncClient(timeout=timeout)
        self.available = True

    async def synthesize(self, text: str, *, voice: str | None = None) -> SpeechAudio | None:
        if not text.strip():
            return None
        started = time.perf_counter()
        voice_id = voice or self._voice_id
        try:
            response = await self._client.post(
                f"{API_BASE}/{voice_id}",
                headers={"xi-api-key": self._api_key, "accept": "audio/mpeg"},
                json={
                    "text": text,
                    "model_id": self._model,
                    "voice_settings": {"stability": 0.45, "similarity_boost": 0.75},
                },
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise SpeechError(
                f"ElevenLabs {exc.response.status_code}: {exc.response.text[:200]}",
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
