"""La voix: choix du timbre, tenue, registre.

Ce module ne peut pas verifier ce qu'on entend — aucun test ne remplace une
oreille. Il verrouille ce qui, lui, est verifiable: qu'aucun nom de voix n'est
ecrit en dur, qu'une panne reseau ne rend pas JARVIS muet, et que le registre
demande arrive bien dans le prompt.
"""

from __future__ import annotations

from typing import Any

import pytest

from jarvis_core.config import Settings
from jarvis_core.voice.delivery import DELIVERIES, JARVIS, get_delivery
from jarvis_core.voice.tts.base import build_tts
from jarvis_core.voice.tts.edge_tts_provider import (
    BRITISH,
    PITCH_PATTERN,
    QUEBEC,
    RATE_PATTERN,
    EdgeTTSProvider,
    can_speak_french,
    choose_voice,
    rank_voice,
)

# Catalogue miniature, de la forme que renvoie le service.
CATALOGUE: list[dict[str, Any]] = [
    {"ShortName": "fr-FR-DeniseNeural", "Locale": "fr-FR", "Gender": "Female"},
    {"ShortName": "fr-FR-HenriNeural", "Locale": "fr-FR", "Gender": "Male"},
    {"ShortName": "fr-CA-SylvieNeural", "Locale": "fr-CA", "Gender": "Female"},
    {"ShortName": "fr-CA-AntoineNeural", "Locale": "fr-CA", "Gender": "Male"},
    {"ShortName": "fr-CA-ThierryMultilingualNeural", "Locale": "fr-CA", "Gender": "Male"},
    {"ShortName": "en-US-AndrewNeural", "Locale": "en-US", "Gender": "Male"},
    # Voix anglaises. Seules les « Multilingual » savent dire du francais.
    {"ShortName": "en-GB-RyanNeural", "Locale": "en-GB", "Gender": "Male"},
    {"ShortName": "en-GB-OllieMultilingualNeural", "Locale": "en-GB", "Gender": "Male"},
    {"ShortName": "en-GB-AdaMultilingualNeural", "Locale": "en-GB", "Gender": "Female"},
]


def test_the_default_voice_is_a_british_butler() -> None:
    """C'est la correction la plus importante de ce module.

    JARVIS est un majordome anglais. Une voix quebecoise, si posee soit-elle,
    ne sera jamais ce personnage. Une voix `en-GB` multilingue prononce le
    francais avec son accent d'origine: c'est exactement l'effet du film.
    """
    assert choose_voice(CATALOGUE) == "en-GB-OllieMultilingualNeural"


def test_a_quebec_voice_still_wins_when_that_accent_is_asked_for() -> None:
    """L'accent britannique est un defaut, pas une obligation."""
    assert choose_voice(CATALOGUE, accent=QUEBEC) == "fr-CA-ThierryMultilingualNeural"


def test_an_english_voice_that_cannot_speak_french_is_never_chosen() -> None:
    """Une voix `en-GB` ordinaire ne dit que de l'anglais.

    Lui donner du francais produirait du charabia. C'est la seule regle dure
    du classement: tout le reste est une preference, celle-ci est un filtre.
    """
    only_english = [
        {"ShortName": "en-GB-RyanNeural", "Locale": "en-GB", "Gender": "Male"},
    ]
    assert choose_voice(only_english) == ""
    assert can_speak_french(only_english[0]) is False


def test_a_male_english_voice_outranks_a_female_english_one() -> None:
    """Le genre passe avant l'accent: c'est ce qu'on entend en premier."""
    male = next(v for v in CATALOGUE if v["ShortName"] == "en-GB-OllieMultilingualNeural")
    female = next(v for v in CATALOGUE if v["ShortName"] == "en-GB-AdaMultilingualNeural")
    assert rank_voice(male, accent=BRITISH) > rank_voice(female, accent=BRITISH)


def test_without_any_english_voice_the_choice_stays_french() -> None:
    """Un catalogue sans voix anglaise ne doit pas laisser JARVIS muet."""
    french_only = [v for v in CATALOGUE if str(v["Locale"]).startswith("fr")]
    assert choose_voice(french_only) == "fr-CA-ThierryMultilingualNeural"


def test_a_female_voice_never_outranks_a_male_one() -> None:
    """Aucun bonus d'accent ne doit pouvoir renverser le genre.

    Le classement a longtemps donne 200 points a la locale exacte contre 100
    au genre: une voix feminine du bon accent passait alors devant une voix
    masculine. Pour un majordome, c'est le mauvais arbitrage.
    """
    modern_female = {
        "ShortName": "fr-CA-XMultilingualNeural",
        "Locale": "fr-CA",
        "Gender": "Female",
    }
    plain_male = {"ShortName": "fr-FR-YNeural", "Locale": "fr-FR", "Gender": "Male"}
    # Vrai quel que soit l'accent demande: le genre domine les deux baremes.
    for accent in (BRITISH, QUEBEC):
        assert rank_voice(plain_male, accent=accent) > rank_voice(modern_female, accent=accent)


def test_no_voice_name_is_hardcoded_anywhere() -> None:
    """Un nom code en dur qui disparait du catalogue rendrait JARVIS muet.

    Le catalogue de Microsoft change; le filtre par attributs, lui, retombe
    toujours sur quelque chose. Ce test le prouve sur un catalogue qui ne
    contient aucun des noms habituels.
    """
    invente = [
        {"ShortName": "fr-CA-ZzzNeural", "Locale": "fr-CA", "Gender": "Male"},
        {"ShortName": "fr-FR-QqqNeural", "Locale": "fr-FR", "Gender": "Female"},
    ]
    assert choose_voice(invente) == "fr-CA-ZzzNeural"


def test_an_empty_catalogue_is_not_a_crash() -> None:
    """Service injoignable: pas de voix, mais pas d'exception non plus."""
    assert choose_voice([]) == ""


def test_a_catalogue_without_french_falls_back_to_silence_not_english() -> None:
    """Mieux vaut la voix du systeme qu'un JARVIS qui baragouine.

    Une voix anglaise non multilingue ne sait pas prononcer le francais: on
    prefere rendre la main au navigateur plutot que produire du charabia.
    """
    english_only = [
        v for v in CATALOGUE
        if str(v["Locale"]).startswith("en") and "Multilingual" not in str(v["ShortName"])
    ]
    assert english_only, "le catalogue de test doit contenir ce cas"
    assert choose_voice(english_only) == ""


@pytest.mark.asyncio
async def test_an_unreachable_service_gives_the_system_voice_back() -> None:
    """Une panne reseau ne doit pas rendre JARVIS muet.

    `synthesize` retourne None, ce que le client interprete comme « parle avec
    la voix du systeme » — degrade, jamais silencieux.
    """
    provider = EdgeTTSProvider()

    async def boom() -> list[dict[str, Any]]:
        raise OSError("reseau coupe")

    provider.list_voices = boom  # type: ignore[method-assign]
    assert await provider.synthesize("Bonsoir.") is None


@pytest.mark.asyncio
async def test_empty_text_is_never_sent_to_the_service() -> None:
    """Synthetiser du vide ferait un aller-retour reseau pour rien."""
    provider = EdgeTTSProvider()
    called = False

    async def watch() -> list[dict[str, Any]]:
        nonlocal called
        called = True
        return CATALOGUE

    provider.list_voices = watch  # type: ignore[method-assign]
    assert await provider.synthesize("   ") is None
    assert called is False


@pytest.mark.asyncio
async def test_the_resolved_voice_is_looked_up_once() -> None:
    """Le catalogue ne doit pas etre redemande a chaque phrase."""
    provider = EdgeTTSProvider()
    calls = 0

    async def counted() -> list[dict[str, Any]]:
        nonlocal calls
        calls += 1
        return CATALOGUE

    provider.list_voices = counted  # type: ignore[method-assign]
    first = await provider.resolve_voice()
    second = await provider.resolve_voice()

    assert first == second == "en-GB-OllieMultilingualNeural"
    assert calls == 1


@pytest.mark.asyncio
async def test_a_configured_voice_skips_the_catalogue_entirely() -> None:
    """Un choix explicite de l'utilisateur prime, et n'attend aucun reseau."""
    provider = EdgeTTSProvider(voice="fr-CA-AntoineNeural")

    async def boom() -> list[dict[str, Any]]:
        raise AssertionError("le catalogue ne devait pas etre consulte")

    provider.list_voices = boom  # type: ignore[method-assign]
    assert await provider.resolve_voice() == "fr-CA-AntoineNeural"


# ------------------------------------------------------------------- la tenue


def test_every_delivery_is_accepted_by_the_engine() -> None:
    """edge-tts refuse un debit ou une hauteur mal formes, a la construction.

    Une valeur invalide ne se verrait qu'au moment de parler — donc trop tard.
    """
    for delivery in DELIVERIES:
        assert RATE_PATTERN.match(delivery.rate), delivery.key
        assert PITCH_PATTERN.match(delivery.pitch), delivery.key


def test_jarvis_speaks_slower_and_lower_than_neutral() -> None:
    """C'est la definition meme de la tenue « JARVIS »."""
    neutre = get_delivery("neutre")
    assert JARVIS.rate.startswith("-") and neutre.rate == "+0%"
    assert JARVIS.pitch.startswith("-") and neutre.pitch == "+0Hz"


def test_an_unknown_delivery_falls_back_to_jarvis() -> None:
    """Un .env mal recopie ne doit pas casser la voix."""
    assert get_delivery("nimportequoi") is JARVIS
    assert get_delivery("") is JARVIS


def test_a_malformed_rate_is_refused_not_passed_through() -> None:
    """Une valeur invalide rendrait le moteur inutilisable des la construction."""
    provider = EdgeTTSProvider(rate="beaucoup", pitch="grave")
    assert provider.rate == "+0%"
    assert provider.pitch == "+0Hz"


def test_the_delivery_reaches_the_engine() -> None:
    """Le reglage doit voyager de .env jusqu'au moteur, sans se perdre."""
    settings = Settings(JARVIS_TTS_PROVIDER="edge", JARVIS_TTS_DELIVERY="grave")
    provider = build_tts(settings)

    assert provider.name == "edge"
    assert provider.pitch == get_delivery("grave").pitch  # type: ignore[attr-defined]


# ---------------------------------------------------------------- le registre
#
# Dans les films, ce qui identifie JARVIS autant que le timbre, c'est le
# vouvoiement et le « Monsieur ». Le reglage doit donc arriver jusqu'au prompt.


def _prompt_for(address: str) -> str:
    from jarvis_core.memory.session import SessionMemory
    from jarvis_core.orchestrator.prompt import build_system_prompt

    settings = Settings(JARVIS_PERSONA_ADDRESS=address)
    return build_system_prompt(settings, SessionMemory("test"))


def test_the_monsieur_register_reaches_the_prompt() -> None:
    prompt = _prompt_for("monsieur")
    assert "Monsieur" in prompt
    assert "vouvoies" in prompt
    assert "tutoyant" not in prompt


def test_the_familiar_register_is_still_reachable() -> None:
    """Le registre du film est un choix, pas une prison."""
    prompt = _prompt_for("familier")
    assert "tutoyant" in prompt
    assert "vouvoies" not in prompt


def test_an_unknown_register_does_not_leave_a_hole_in_the_prompt() -> None:
    """Un .env mal recopie ne doit pas produire un prompt sans regle d'adresse."""
    prompt = _prompt_for("nimportequoi")
    assert "tutoyant" in prompt
    assert "{address}" not in prompt


def test_monsieur_is_told_not_to_be_repeated() -> None:
    """« Monsieur » a chaque phrase, c'est une caricature, pas un majordome."""
    prompt = _prompt_for("monsieur")
    assert "une fois par reponse" in prompt


# ------------------------------------------------- le chemin qui parle vraiment
#
# Le service de synthese n'est pas joignable depuis l'environnement de test.
# On remplace donc le moteur par un double qui rend des fragments audio, ce qui
# verifie tout ce qui nous appartient: les reglages transmis, l'assemblage des
# fragments, et le type de l'audio produit.


class _FakeCommunicate:
    """Double de `edge_tts.Communicate`. Retient ce qu'on lui a demande."""

    last: dict[str, str] = {}

    def __init__(self, text: str, voice: str, *, rate: str, pitch: str) -> None:
        _FakeCommunicate.last = {
            "text": text,
            "voice": voice,
            "rate": rate,
            "pitch": pitch,
        }

    async def stream(self):  # type: ignore[no-untyped-def]
        yield {"type": "WordBoundary", "offset": 0}
        yield {"type": "audio", "data": b"ID3-debut"}
        yield {"type": "audio", "data": b"-suite"}


class _FakeEdge:
    Communicate = _FakeCommunicate

    @staticmethod
    async def list_voices() -> list[dict[str, Any]]:
        return CATALOGUE


@pytest.fixture()
def fake_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    from jarvis_core.voice.tts import edge_tts_provider

    monkeypatch.setattr(edge_tts_provider, "_edge_tts", lambda: _FakeEdge)


@pytest.mark.asyncio
async def test_the_audio_fragments_are_assembled_in_order(fake_engine: None) -> None:
    """Un fragment perdu ou inverse s'entendrait immediatement."""
    audio = await EdgeTTSProvider().synthesize("Bonsoir Monsieur.")

    assert audio is not None
    assert audio.data == b"ID3-debut-suite"
    assert audio.mime == "audio/mpeg"
    assert audio.provider == "edge"


@pytest.mark.asyncio
async def test_the_delivery_is_actually_sent_to_the_engine(fake_engine: None) -> None:
    """Le reglage doit arriver au moteur, pas seulement etre stocke."""
    provider = EdgeTTSProvider(rate=JARVIS.rate, pitch=JARVIS.pitch)
    await provider.synthesize("Bonsoir.")

    assert _FakeCommunicate.last["rate"] == JARVIS.rate
    assert _FakeCommunicate.last["pitch"] == JARVIS.pitch
    assert _FakeCommunicate.last["voice"] == "en-GB-OllieMultilingualNeural"


@pytest.mark.asyncio
async def test_a_one_off_voice_does_not_replace_the_configured_one(
    fake_engine: None,
) -> None:
    """Ecouter un essai ne doit rien changer au reglage retenu."""
    provider = EdgeTTSProvider(voice="fr-CA-AntoineNeural")
    await provider.synthesize("Essai.", voice="fr-FR-HenriNeural")

    assert _FakeCommunicate.last["voice"] == "fr-FR-HenriNeural"
    assert provider.configured_voice == "fr-CA-AntoineNeural"


@pytest.mark.asyncio
async def test_a_stream_without_audio_is_not_a_silent_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rendre un audio vide ferait jouer du silence: on rend None."""
    from jarvis_core.voice.tts import edge_tts_provider

    class _Mute(_FakeCommunicate):
        async def stream(self):  # type: ignore[no-untyped-def]
            yield {"type": "WordBoundary", "offset": 0}

    class _MuteEdge(_FakeEdge):
        Communicate = _Mute

    monkeypatch.setattr(edge_tts_provider, "_edge_tts", lambda: _MuteEdge)
    assert await EdgeTTSProvider().synthesize("Bonsoir.") is None


# ------------------------------------------------------- la bascule au demarrage
#
# `null` fait parler le navigateur. La bascule vers le moteur neuronal doit se
# faire toute seule — l'utilisateur n'a pas a editer un fichier pour avoir une
# voix correcte — mais sans jamais ecraser un choix qu'il aurait fait lui-meme.


def _setup_in(tmp_path: Any, provider: str) -> tuple[Any, str]:
    from jarvis_core.setup_assistant import run_setup

    root = tmp_path
    example = "JARVIS_TTS_PROVIDER=null\nJARVIS_DOCUMENTS_DIR=\n"
    (root / ".env.example").write_text(example, encoding="utf-8")
    (root / ".env").write_text(
        f"JARVIS_TTS_PROVIDER={provider}\nJARVIS_DOCUMENTS_DIR=\n", encoding="utf-8"
    )
    report = run_setup(root, Settings(JARVIS_TTS_PROVIDER=provider))
    return report, (root / ".env").read_text(encoding="utf-8")


def test_the_browser_voice_is_upgraded_automatically(tmp_path: Any) -> None:
    """Personne ne devrait avoir a editer un fichier pour etre bien entendu."""
    _, env = _setup_in(tmp_path, "null")
    assert "JARVIS_TTS_PROVIDER=edge" in env


def test_a_deliberate_engine_choice_is_never_overwritten(tmp_path: Any) -> None:
    """Quelqu'un qui paie pour ElevenLabs ne doit pas le perdre au demarrage."""
    _, env = _setup_in(tmp_path, "elevenlabs")
    assert "JARVIS_TTS_PROVIDER=elevenlabs" in env
    assert "edge" not in env


@pytest.mark.asyncio
async def test_changing_accent_forgets_the_voice_it_had_deduced() -> None:
    """Sinon le reglage aurait l'air d'avoir pris sans rien changer."""
    provider = EdgeTTSProvider(accent=BRITISH)

    async def catalogue() -> list[dict[str, Any]]:
        return CATALOGUE

    provider.list_voices = catalogue  # type: ignore[method-assign]
    assert await provider.resolve_voice() == "en-GB-OllieMultilingualNeural"

    provider.set_accent(QUEBEC)
    assert await provider.resolve_voice() == "fr-CA-ThierryMultilingualNeural"


def test_changing_accent_releases_a_voice_pinned_under_the_old_one(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sinon le selecteur d'accent semble ne rien faire.

    Une voix choisie explicitement gagne sur l'accent — c'est voulu. Mais
    demander un autre accent sans nommer de voix veut dire « choisis-en une
    qui correspond »: la voix epinglee doit alors etre relachee, sans quoi
    JARVIS garde l'ancienne et l'utilisateur conclut que le reglage est casse.
    """
    from fastapi.testclient import TestClient

    from jarvis_core.api.app import create_app
    from jarvis_core.voice.tts import edge_tts_provider

    class _Edge:
        Communicate = _FakeCommunicate

        @staticmethod
        async def list_voices() -> list[dict[str, Any]]:
            return CATALOGUE

    monkeypatch.setattr(edge_tts_provider, "_edge_tts", lambda: _Edge)
    monkeypatch.setenv("JARVIS_TTS_PROVIDER", "edge")
    # `.env` est reecrit par la route: on l'isole dans un dossier temporaire.
    (tmp_path / ".env").write_text("JARVIS_TTS_PROVIDER=edge\n", encoding="utf-8")
    monkeypatch.setattr(
        "jarvis_core.api.routes_settings.find_project_root", lambda: tmp_path
    )

    with TestClient(create_app()) as client:
        client.post("/api/settings/voice", json={"voice": "fr-CA-AntoineNeural"})
        assert client.get("/api/settings/voice").json()["resolved"] == "fr-CA-AntoineNeural"

        client.post("/api/settings/voice", json={"accent": "britannique"})
        assert (
            client.get("/api/settings/voice").json()["resolved"]
            == "en-GB-OllieMultilingualNeural"
        )
