"""Pipeline vocal: Speech-to-Text et Text-to-Speech, derriere des abstractions."""

from jarvis_core.voice.stt.base import SpeechToTextProvider, Transcript
from jarvis_core.voice.tts.base import SpeechAudio, TextToSpeechProvider

__all__ = ["SpeechAudio", "SpeechToTextProvider", "TextToSpeechProvider", "Transcript"]
