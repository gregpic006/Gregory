"""Abstraction Speech-to-Text.

Criteres qui ont guide l'interface: francais quebecois, alternance
francais/anglais dans une meme phrase, faible latence, et possibilite de
brancher un moteur local (aucune donnee qui sort de la machine) ou un service
en ligne, sans rien changer ailleurs dans le code.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass

from jarvis_core.config import Settings


@dataclass
class Transcript:
    """Resultat d'une transcription."""

    text: str
    language: str = ""
    provider: str = ""
    duration_ms: int = 0
    is_final: bool = True

    def as_dict(self) -> dict[str, object]:
        return {
            "text": self.text,
            "language": self.language,
            "provider": self.provider,
            "duration_ms": self.duration_ms,
            "final": self.is_final,
        }


class SpeechToTextProvider(abc.ABC):
    """Interface commune a tous les moteurs de transcription."""

    name: str = "abstract"
    available: bool = False

    @abc.abstractmethod
    async def transcribe(
        self, audio: bytes, *, mime: str = "audio/webm", language: str | None = None
    ) -> Transcript:
        """Transcrit un extrait audio complet.

        Args:
            audio: contenu binaire (webm/opus, wav, mp3...).
            mime: type MIME de l'extrait.
            language: code BCP-47 souhaite; `None` laisse le moteur detecter.

        Raises:
            SpeechError: si le moteur n'est pas configure ou echoue.
        """

    async def aclose(self) -> None:
        return None


def build_stt(settings: Settings) -> SpeechToTextProvider:
    """Instancie le moteur declare en configuration."""
    if settings.stt_provider == "openai":
        from jarvis_core.voice.stt.openai_stt import OpenAISTTProvider

        return OpenAISTTProvider(
            api_key=settings.openai_api_key, model=settings.stt_openai_model
        )
    if settings.stt_provider == "faster_whisper":
        from jarvis_core.voice.stt.local_whisper import FasterWhisperProvider

        return FasterWhisperProvider(
            model_size=settings.stt_local_model, compute_type=settings.stt_local_compute
        )
    from jarvis_core.voice.stt.null_stt import NullSTTProvider

    return NullSTTProvider()
