"""Abstraction Text-to-Speech.

La voix visee: masculine, calme, naturelle, faible latence.  L'interface
retourne un audio complet pour le MVP; la generation par phrases (pour demarrer
la lecture avant la fin du texte) et l'interruption (barge-in) sont gerees
cote client, qui coupe la lecture des qu'un nouveau tour de parole commence.
"""

from __future__ import annotations

import abc
import re
from dataclasses import dataclass

from jarvis_core.config import Settings


@dataclass
class SpeechAudio:
    """Audio synthetise."""

    data: bytes
    mime: str
    provider: str
    duration_ms: int = 0


class TextToSpeechProvider(abc.ABC):
    """Interface commune aux moteurs de synthese."""

    name: str = "abstract"
    available: bool = False

    @abc.abstractmethod
    async def synthesize(self, text: str, *, voice: str | None = None) -> SpeechAudio | None:
        """Synthetise `text`.

        Returns:
            L'audio, ou `None` si aucun moteur serveur n'est configure - dans ce
            cas le client utilise la voix du systeme d'exploitation.
        """

    async def aclose(self) -> None:
        return None


def split_sentences(text: str, *, max_chars: int = 240) -> list[str]:
    """Decoupe un texte en phrases, pour synthetiser au fil de l'eau."""
    raw = re.split(r"(?<=[.!?…])\s+", text.strip())
    chunks: list[str] = []
    buffer = ""
    for sentence in raw:
        if not sentence:
            continue
        if len(buffer) + len(sentence) + 1 <= max_chars:
            buffer = f"{buffer} {sentence}".strip()
        else:
            if buffer:
                chunks.append(buffer)
            buffer = sentence
    if buffer:
        chunks.append(buffer)
    return chunks


def build_tts(settings: Settings) -> TextToSpeechProvider:
    """Instancie le moteur declare en configuration."""
    if settings.tts_provider == "edge":
        from jarvis_core.voice.delivery import get_delivery
        from jarvis_core.voice.tts.edge_tts_provider import EdgeTTSProvider

        delivery = get_delivery(settings.tts_delivery)
        return EdgeTTSProvider(
            voice=settings.tts_edge_voice,
            rate=delivery.rate,
            pitch=delivery.pitch,
        )
    if settings.tts_provider == "elevenlabs":
        from jarvis_core.voice.tts.elevenlabs_tts import ElevenLabsTTSProvider

        return ElevenLabsTTSProvider(
            api_key=settings.elevenlabs_api_key,
            voice_id=settings.tts_elevenlabs_voice_id,
            model=settings.tts_elevenlabs_model,
            stability=settings.tts_stability,
            similarity=settings.tts_similarity,
            style=settings.tts_style,
            speaker_boost=settings.tts_speaker_boost,
        )
    if settings.tts_provider == "openai":
        from jarvis_core.voice.tts.openai_tts import OpenAITTSProvider

        return OpenAITTSProvider(
            api_key=settings.openai_api_key,
            model=settings.tts_openai_model,
            voice=settings.tts_openai_voice,
        )
    from jarvis_core.voice.tts.null_tts import NullTTSProvider

    return NullTTSProvider()
