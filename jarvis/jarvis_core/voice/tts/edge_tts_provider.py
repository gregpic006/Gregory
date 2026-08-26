"""Synthese vocale par les voix neuronales de Microsoft Edge.

C'est le seul moteur de qualite qui ne demande ni carte de credit ni cle
d'API: les memes voix que celles du navigateur Edge, mais pilotees depuis le
serveur — donc avec le controle du debit et de la hauteur, que le navigateur
n'expose pas.

Ce controle est tout l'interet ici. Le timbre seul ne fait pas la voix de
JARVIS: c'est le **debit pose** et la **hauteur basse** qui donnent le calme.
Une voix neuronale reglee a plat sonne comme un GPS.

Deux partis pris.

**Aucun nom de voix n'est ecrit en dur.** La liste est demandee au service et
filtree par attributs (langue, genre, generation). Un nom code en dur qui
disparait du catalogue rendrait JARVIS muet; un filtre, lui, retombe toujours
sur quelque chose.

**Une panne reseau n'est pas une panne de voix.** Si le service ne repond pas,
`synthesize` retourne `None` et le client reprend la voix du systeme. On perd
en qualite, jamais la parole.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any

from jarvis_core.voice.tts.base import SpeechAudio, TextToSpeechProvider

logger = logging.getLogger(__name__)

#: Formats acceptes par edge-tts. Une valeur hors format leve a la construction.
RATE_PATTERN = re.compile(r"^[+-]\d+%$")
PITCH_PATTERN = re.compile(r"^[+-]\d+Hz$")

#: Le service repond d'ordinaire en moins d'une seconde.
SYNTHESIS_TIMEOUT = 25.0
VOICE_LIST_TIMEOUT = 15.0


@dataclass(frozen=True)
class VoiceChoice:
    """Une voix proposee a l'utilisateur."""

    id: str
    label: str
    locale: str
    gender: str
    #: Generation recente (voix « Multilingual »), nettement plus naturelle.
    modern: bool

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "locale": self.locale,
            "gender": self.gender,
            "modern": self.modern,
        }


def _pretty(short_name: str) -> str:
    """`fr-CA-AntoineNeural` -> `Antoine (fr-CA)`.

    Le nom technique ne dit rien a l'oreille; le prenom, si.
    """
    parts = short_name.split("-")
    if len(parts) < 3:
        return short_name
    locale = "-".join(parts[:2])
    name = parts[2]
    for suffix in ("MultilingualNeural", "Neural"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return f"{name} ({locale})"


def rank_voice(voice: dict[str, Any], *, prefer_locale: str = "fr-CA") -> int:
    """Classe les voix francaises: la plus proche de JARVIS d'abord.

    On classe par **attributs**, jamais par nom: le catalogue de Microsoft
    change, les attributs restent.
    """
    short = str(voice.get("ShortName", ""))
    locale = str(voice.get("Locale", ""))
    gender = str(voice.get("Gender", ""))

    points = 0
    # Une voix masculine, grave: c'est la premiere chose qu'on entend.
    if gender == "Male":
        points += 100
    # Les voix « Multilingual » sont d'une generation au-dessus.
    if "Multilingual" in short:
        points += 40
    if locale == prefer_locale:
        points += 20
    elif locale.startswith(prefer_locale.split("-")[0]):
        points += 10
    return points


def choose_voice(voices: list[dict[str, Any]], *, prefer_locale: str = "fr-CA") -> str:
    """Retient la meilleure voix disponible, ou une chaine vide si aucune."""
    french = [v for v in voices if str(v.get("Locale", "")).startswith("fr")]
    if not french:
        return ""
    best = max(french, key=lambda v: rank_voice(v, prefer_locale=prefer_locale))
    return str(best.get("ShortName", ""))


class EdgeTTSProvider(TextToSpeechProvider):
    """Voix neuronales Microsoft, sans cle d'API."""

    name = "edge"

    def __init__(
        self,
        *,
        voice: str = "",
        rate: str = "+0%",
        pitch: str = "+0Hz",
        prefer_locale: str = "fr-CA",
    ) -> None:
        self.configured_voice = voice.strip()
        self.rate = rate if RATE_PATTERN.match(rate) else "+0%"
        self.pitch = pitch if PITCH_PATTERN.match(pitch) else "+0Hz"
        self.prefer_locale = prefer_locale
        self.available = _edge_tts() is not None
        # Resolue au premier usage: demander le catalogue au demarrage
        # retarderait le lancement pour une information dont on n'a pas
        # encore besoin.
        self._resolved: str = ""
        self._lock = asyncio.Lock()

    async def resolve_voice(self) -> str:
        """Nom reel de la voix utilisee. Vide si le service est injoignable."""
        if self.configured_voice:
            return self.configured_voice
        if self._resolved:
            return self._resolved
        async with self._lock:
            if self._resolved:
                return self._resolved
            voices = await self.list_voices()
            self._resolved = choose_voice(voices, prefer_locale=self.prefer_locale)
            if self._resolved:
                logger.info("voix retenue: %s", self._resolved)
            return self._resolved

    async def list_voices(self) -> list[dict[str, Any]]:
        """Catalogue brut du service. Liste vide s'il est injoignable."""
        module = _edge_tts()
        if module is None:
            return []
        try:
            async with asyncio.timeout(VOICE_LIST_TIMEOUT):
                voices = await module.list_voices()
        except Exception as exc:  # noqa: BLE001 - une panne reseau n'est pas fatale
            logger.warning("catalogue de voix injoignable: %s", exc)
            return []
        return list(voices)

    async def french_voices(self) -> list[VoiceChoice]:
        """Voix francaises, de la plus proche de JARVIS a la plus eloignee."""
        voices = [
            v for v in await self.list_voices() if str(v.get("Locale", "")).startswith("fr")
        ]
        voices.sort(key=lambda v: rank_voice(v, prefer_locale=self.prefer_locale), reverse=True)
        return [
            VoiceChoice(
                id=str(v.get("ShortName", "")),
                label=_pretty(str(v.get("ShortName", ""))),
                locale=str(v.get("Locale", "")),
                gender=str(v.get("Gender", "")),
                modern="Multilingual" in str(v.get("ShortName", "")),
            )
            for v in voices
            if v.get("ShortName")
        ]

    async def synthesize(self, text: str, *, voice: str | None = None) -> SpeechAudio | None:
        """Synthetise `text`. Retourne `None` si le service n'a rien rendu."""
        module = _edge_tts()
        clean = text.strip()
        if module is None or not clean:
            return None

        # La resolution de la voix est dans le meme `try` que la synthese:
        # elle peut demander le catalogue au reseau, et une panne a ce
        # moment-la doit rendre la voix du systeme, pas remonter dans le tour
        # de parole.
        chosen = ""
        try:
            chosen = (voice or "").strip() or await self.resolve_voice()
            if not chosen:
                # Aucune voix: le client parlera avec celle du systeme.
                return None
            async with asyncio.timeout(SYNTHESIS_TIMEOUT):
                audio = await self._collect(module, clean, chosen)
        except Exception as exc:  # noqa: BLE001 - on retombe sur la voix du systeme
            logger.warning("synthese impossible (%s): %s", chosen or "voix inconnue", exc)
            return None

        if not audio:
            return None
        return SpeechAudio(data=audio, mime="audio/mpeg", provider=self.name)

    async def _collect(self, module: Any, text: str, voice: str) -> bytes:
        """Rassemble les fragments audio du flux."""
        speech = module.Communicate(text, voice, rate=self.rate, pitch=self.pitch)
        chunks: list[bytes] = []
        async for message in speech.stream():
            if message.get("type") == "audio" and message.get("data"):
                chunks.append(bytes(message["data"]))
        return b"".join(chunks)


def _edge_tts() -> Any | None:
    """Importe edge-tts, ou None s'il n'est pas installe.

    Import tardif: le paquet n'est necessaire que si ce moteur est choisi, et
    son absence ne doit pas empecher JARVIS de demarrer.
    """
    try:
        import edge_tts
    except ImportError:  # pragma: no cover - depend de l'installation
        logger.warning("edge-tts n'est pas installe: la voix du systeme sera utilisee")
        return None
    return edge_tts
