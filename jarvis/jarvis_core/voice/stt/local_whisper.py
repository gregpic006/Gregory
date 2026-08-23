"""Transcription locale avec faster-whisper.

Interet: aucune donnee audio ne quitte la machine, et le cout marginal est nul.
Le modele est charge paresseusement au premier usage, puis reutilise.
Le decodage tourne dans un thread pour ne pas bloquer la boucle asyncio.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
import time
from pathlib import Path
from typing import Any

from jarvis_core.errors import ConfigurationError, SpeechError
from jarvis_core.voice.stt.base import SpeechToTextProvider, Transcript

logger = logging.getLogger(__name__)


class FasterWhisperProvider(SpeechToTextProvider):
    """Whisper local via CTranslate2."""

    name = "faster_whisper"

    def __init__(self, *, model_size: str = "small", compute_type: str = "int8") -> None:
        self._model_size = model_size
        self._compute_type = compute_type
        self._model: Any | None = None
        self._lock = asyncio.Lock()
        self.available = True

    async def _ensure_model(self) -> Any:
        if self._model is not None:
            return self._model
        async with self._lock:
            if self._model is not None:
                return self._model
            try:
                from faster_whisper import WhisperModel
            except ImportError as exc:  # pragma: no cover - depend de l'install
                raise ConfigurationError(
                    "faster-whisper n'est pas installe. "
                    "Installer avec: pip install 'jarvis-core[local-stt]'"
                ) from exc
            logger.info("chargement du modele Whisper local (%s)", self._model_size)
            self._model = await asyncio.to_thread(
                WhisperModel, self._model_size, device="auto", compute_type=self._compute_type
            )
            return self._model

    async def transcribe(
        self, audio: bytes, *, mime: str = "audio/webm", language: str | None = None
    ) -> Transcript:
        if not audio:
            raise SpeechError("extrait audio vide", user_message="Je n'ai rien entendu.")
        model = await self._ensure_model()
        started = time.perf_counter()
        suffix = ".webm" if "webm" in mime else ".wav"
        path = Path(tempfile.gettempdir()) / f"jarvis_{int(time.time() * 1000)}{suffix}"
        path.write_bytes(audio)
        try:
            text, detected = await asyncio.to_thread(
                _run_transcription, model, str(path), language
            )
        except Exception as exc:  # noqa: BLE001
            raise SpeechError(
                repr(exc), user_message="La transcription locale a echoue."
            ) from exc
        finally:
            path.unlink(missing_ok=True)

        return Transcript(
            text=text.strip(),
            language=detected,
            provider=self.name,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )


def _run_transcription(model: Any, path: str, language: str | None) -> tuple[str, str]:
    segments, info = model.transcribe(
        path,
        language=language.split("-")[0] if language else None,
        vad_filter=True,
        beam_size=1,  # priorite a la latence
    )
    return " ".join(segment.text for segment in segments), getattr(info, "language", "")
