"""Tests du pipeline vocal.

On teste NOTRE code, pas la qualite de Whisper: preparation de l'audio,
passage des parametres, nettoyage des fichiers temporaires, et surtout le
comportement en cas de panne — un echec vocal doit produire une phrase
utilisable, jamais une pile d'appels.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from jarvis_core.config import Settings
from jarvis_core.errors import SpeechError
from jarvis_core.voice.stt.base import build_stt
from jarvis_core.voice.stt.local_whisper import FasterWhisperProvider
from jarvis_core.voice.stt.null_stt import NullSTTProvider
from jarvis_core.voice.tts.base import build_tts, split_sentences
from jarvis_core.voice.tts.null_tts import NullTTSProvider


class _StubSegment:
    def __init__(self, text: str) -> None:
        self.text = text


class _StubInfo:
    language = "fr"


class _StubModel:
    """Modele Whisper factice: enregistre ce qu'on lui demande."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.seen_file_exists = False

    def transcribe(self, path: str, **kwargs: Any) -> tuple[list[_StubSegment], _StubInfo]:
        self.seen_file_exists = Path(path).exists()
        self.calls.append({"path": path, **kwargs})
        return [_StubSegment("Jarvis, "), _StubSegment("qu'est-ce que j'ai demain")], _StubInfo()


# =============================================================================
# Absence de moteur: explicite, jamais silencieuse
# =============================================================================


async def test_no_stt_engine_refuses_clearly() -> None:
    with pytest.raises(SpeechError) as excinfo:
        await NullSTTProvider().transcribe(b"audio")
    assert "n'est pas configuree" in excinfo.value.user_message
    assert "ecris-moi" in excinfo.value.user_message


async def test_no_tts_engine_falls_back_to_the_system_voice() -> None:
    """L'absence de TTS n'est pas bloquante: le client lit avec la voix systeme."""
    assert await NullTTSProvider().synthesize("Bonsoir.") is None
    assert NullTTSProvider().available is False


def test_providers_are_selected_by_configuration() -> None:
    assert build_stt(Settings(JARVIS_STT_PROVIDER="null")).name == "null"
    assert build_tts(Settings(JARVIS_TTS_PROVIDER="null")).name == "null"


# =============================================================================
# Whisper local
# =============================================================================


async def test_audio_reaches_the_model_and_the_temp_file_is_cleaned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = FasterWhisperProvider(model_size="base")
    stub = _StubModel()

    async def fake_model() -> Any:
        return stub

    monkeypatch.setattr(provider, "_ensure_model", fake_model)
    result = await provider.transcribe(b"RIFF-fake-audio", mime="audio/wav", language="fr-CA")

    assert result.text == "Jarvis,  qu'est-ce que j'ai demain"
    assert result.language == "fr"
    assert stub.seen_file_exists, "le modele doit recevoir un fichier reellement ecrit"
    assert not Path(stub.calls[0]["path"]).exists(), "le fichier temporaire doit etre supprime"


async def test_transcription_is_tuned_for_conversation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Filtrage de silence actif et faisceau etroit: la latence prime ici."""
    provider = FasterWhisperProvider()
    stub = _StubModel()

    async def fake_model() -> Any:
        return stub

    monkeypatch.setattr(provider, "_ensure_model", fake_model)
    await provider.transcribe(b"audio", language="fr-CA")

    call = stub.calls[0]
    assert call["language"] == "fr", "'fr-CA' doit devenir 'fr' pour le moteur"
    assert call["vad_filter"] is True
    assert call["beam_size"] == 1


async def test_empty_audio_is_refused_before_loading_a_model() -> None:
    provider = FasterWhisperProvider()
    with pytest.raises(SpeechError) as excinfo:
        await provider.transcribe(b"")
    assert "Je n'ai rien entendu" in excinfo.value.user_message


async def test_model_download_failure_stays_readable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cas reel: pas de reseau, ou proxy qui bloque le telechargement."""
    provider = FasterWhisperProvider(model_size="small")

    def exploding_model(*args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("403 Forbidden depuis le proxy")

    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", exploding_model)
    with pytest.raises(SpeechError) as excinfo:
        await provider.transcribe(b"audio")

    message = excinfo.value.user_message
    assert "modele de reconnaissance vocale" in message
    assert "JARVIS_STT_PROVIDER=openai" in message
    assert "mode texte reste disponible" in message
    assert "Traceback" not in message


async def test_model_is_loaded_once_even_under_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deux tours simultanes ne doivent pas charger le modele deux fois."""
    provider = FasterWhisperProvider()
    loads = 0
    stub = _StubModel()

    def counting_model(*args: Any, **kwargs: Any) -> Any:
        nonlocal loads
        loads += 1
        return stub

    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", counting_model)
    await asyncio.gather(
        provider.transcribe(b"a", language="fr"), provider.transcribe(b"b", language="fr")
    )
    assert loads == 1


# =============================================================================
# Synthese: decoupage pour demarrer la lecture au plus tot
# =============================================================================


def test_sentences_are_split_for_early_playback() -> None:
    text = (
        "Assez chargee. Premier rendez-vous a 8 h 30. "
        "Trois meetings avant midi, et ton apres-midi est libre apres 15 h."
    )
    chunks = split_sentences(text, max_chars=60)
    assert len(chunks) > 1
    assert chunks[0].startswith("Assez chargee")
    assert "".join(chunks).replace(" ", "") == text.replace(" ", "")


def test_short_answers_are_not_split_needlessly() -> None:
    assert split_sentences("Bon matin, Greg.") == ["Bon matin, Greg."]


def test_empty_text_produces_nothing_to_say() -> None:
    assert split_sentences("   ") == []
