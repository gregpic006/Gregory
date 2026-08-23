"""Moteur STT inactif.

Present pour que le systeme demarre sans cle API.  Il echoue explicitement:
JARVIS dira "la reconnaissance vocale n'est pas configuree" plutot que de
faire semblant d'avoir entendu quelque chose.
"""

from __future__ import annotations

from jarvis_core.errors import SpeechError
from jarvis_core.voice.stt.base import SpeechToTextProvider, Transcript


class NullSTTProvider(SpeechToTextProvider):
    name = "null"
    available = False

    async def transcribe(
        self, audio: bytes, *, mime: str = "audio/webm", language: str | None = None
    ) -> Transcript:
        raise SpeechError(
            "aucun moteur STT configure",
            user_message=(
                "La reconnaissance vocale n'est pas configuree. Choisis un moteur avec "
                "JARVIS_STT_PROVIDER (openai ou faster_whisper), ou ecris-moi ta demande."
            ),
        )
