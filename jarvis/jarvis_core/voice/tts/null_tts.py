"""Moteur TTS inactif: la voix du systeme prend le relais cote client.

Contrairement au STT, l'absence de moteur serveur n'est pas bloquante: le
navigateur sait lire du texte a voix haute.  On retourne donc `None` et le
client bascule sur `speechSynthesis`.
"""

from __future__ import annotations

from jarvis_core.voice.tts.base import SpeechAudio, TextToSpeechProvider


class NullTTSProvider(TextToSpeechProvider):
    name = "null"
    available = False

    async def synthesize(self, text: str, *, voice: str | None = None) -> SpeechAudio | None:
        return None
