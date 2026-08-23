"""Transcription via l'API audio d'OpenAI (Whisper / gpt-4o-transcribe).

Appel HTTP direct (httpx) plutot que le SDK: une dependance de moins, et le
point d'API `/v1/audio/transcriptions` est stable.
"""

from __future__ import annotations

import time

import httpx

from jarvis_core.errors import ConfigurationError, SpeechError
from jarvis_core.voice.stt.base import SpeechToTextProvider, Transcript

API_URL = "https://api.openai.com/v1/audio/transcriptions"

_EXTENSIONS = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
}


class OpenAISTTProvider(SpeechToTextProvider):
    """Transcription hebergee, bonne sur le francais quebecois et le code-switching."""

    name = "openai"

    def __init__(
        self, api_key: str, *, model: str = "gpt-4o-transcribe", timeout: float = 30.0
    ) -> None:
        if not api_key:
            raise ConfigurationError(
                "OPENAI_API_KEY est requise pour JARVIS_STT_PROVIDER=openai."
            )
        self._api_key = api_key
        self._model = model
        self._client = httpx.AsyncClient(timeout=timeout)
        self.available = True

    async def transcribe(
        self, audio: bytes, *, mime: str = "audio/webm", language: str | None = None
    ) -> Transcript:
        if not audio:
            raise SpeechError("extrait audio vide", user_message="Je n'ai rien entendu.")
        started = time.perf_counter()
        extension = _EXTENSIONS.get(mime.split(";")[0].strip(), "webm")
        data: dict[str, str] = {"model": self._model}
        if language:
            # L'API attend un code ISO-639-1 ("fr"), pas "fr-CA".
            data["language"] = language.split("-")[0]
        try:
            response = await self._client.post(
                API_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                data=data,
                files={"file": (f"audio.{extension}", audio, mime)},
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise SpeechError(
                f"OpenAI STT {exc.response.status_code}: {exc.response.text[:200]}",
                user_message="Le service de transcription a refuse la requete.",
            ) from exc
        except httpx.HTTPError as exc:
            raise SpeechError(
                str(exc), user_message="Je n'arrive pas a joindre le service de transcription."
            ) from exc

        payload = response.json()
        return Transcript(
            text=(payload.get("text") or "").strip(),
            language=language or "",
            provider=self.name,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    async def aclose(self) -> None:
        await self._client.aclose()
