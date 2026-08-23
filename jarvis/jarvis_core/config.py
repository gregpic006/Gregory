"""Configuration centralisee de JARVIS.

Toute la configuration passe par des variables d'environnement (fichier `.env`
en developpement, secret manager en production).  Aucune cle n'est jamais
ecrite dans le code.
"""

from __future__ import annotations

import functools
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from jarvis_core.errors import ConfigurationError

LLMProviderName = Literal["anthropic", "mock"]
STTProviderName = Literal["openai", "faster_whisper", "null"]
TTSProviderName = Literal["elevenlabs", "openai", "null"]


class Settings(BaseSettings):
    """Configuration applicative, chargee une seule fois au demarrage."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="",
        extra="ignore",
        case_sensitive=False,
    )

    # --- Identite ------------------------------------------------------------
    jarvis_name: str = Field(default="Jarvis", alias="JARVIS_NAME")
    user_name: str = Field(default="", alias="JARVIS_USER_NAME")
    default_language: str = Field(default="fr-CA", alias="JARVIS_DEFAULT_LANGUAGE")
    timezone: str = Field(default="America/Montreal", alias="JARVIS_TIMEZONE")

    # --- Environnement -------------------------------------------------------
    env: Literal["development", "production"] = Field(
        default="development", alias="JARVIS_ENV"
    )
    dry_run: bool = Field(default=True, alias="JARVIS_DRY_RUN")
    log_level: str = Field(default="INFO", alias="JARVIS_LOG_LEVEL")

    # --- Serveur -------------------------------------------------------------
    host: str = Field(default="127.0.0.1", alias="JARVIS_HOST")
    port: int = Field(default=8787, alias="JARVIS_PORT")
    cors_origins: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173", alias="JARVIS_CORS_ORIGINS"
    )

    # --- LLM -----------------------------------------------------------------
    llm_provider: LLMProviderName = Field(default="anthropic", alias="JARVIS_LLM_PROVIDER")
    anthropic_api_key: str = Field(default="", alias="ANTHROPIC_API_KEY")
    llm_model_fast: str = Field(default="claude-haiku-4-5", alias="JARVIS_LLM_MODEL_FAST")
    llm_model_balanced: str = Field(default="claude-opus-5", alias="JARVIS_LLM_MODEL_BALANCED")
    llm_model_deep: str = Field(default="claude-opus-5", alias="JARVIS_LLM_MODEL_DEEP")
    llm_max_tokens: int = Field(default=2000, alias="JARVIS_LLM_MAX_TOKENS")
    llm_daily_budget_usd: float = Field(default=5.0, alias="JARVIS_LLM_DAILY_BUDGET_USD")

    # --- Speech-to-Text ------------------------------------------------------
    stt_provider: STTProviderName = Field(default="null", alias="JARVIS_STT_PROVIDER")
    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    stt_openai_model: str = Field(default="gpt-4o-transcribe", alias="JARVIS_STT_OPENAI_MODEL")
    stt_local_model: str = Field(default="small", alias="JARVIS_STT_LOCAL_MODEL")
    stt_local_compute: str = Field(default="int8", alias="JARVIS_STT_LOCAL_COMPUTE")

    # --- Text-to-Speech ------------------------------------------------------
    tts_provider: TTSProviderName = Field(default="null", alias="JARVIS_TTS_PROVIDER")
    elevenlabs_api_key: str = Field(default="", alias="ELEVENLABS_API_KEY")
    tts_elevenlabs_voice_id: str = Field(default="", alias="JARVIS_TTS_ELEVENLABS_VOICE_ID")
    tts_elevenlabs_model: str = Field(
        default="eleven_turbo_v2_5", alias="JARVIS_TTS_ELEVENLABS_MODEL"
    )
    # Reglages de timbre ElevenLabs. Valeurs par defaut choisies pour une voix
    # posee: stabilite haute (peu de variation d'intonation), style bas (peu
    # d'emphase dramatique). C'est ce qui distingue un assistant d'un acteur.
    tts_stability: float = Field(default=0.55, alias="JARVIS_TTS_STABILITY")
    tts_similarity: float = Field(default=0.80, alias="JARVIS_TTS_SIMILARITY")
    tts_style: float = Field(default=0.10, alias="JARVIS_TTS_STYLE")
    tts_speaker_boost: bool = Field(default=True, alias="JARVIS_TTS_SPEAKER_BOOST")
    tts_openai_model: str = Field(default="gpt-4o-mini-tts", alias="JARVIS_TTS_OPENAI_MODEL")
    tts_openai_voice: str = Field(default="onyx", alias="JARVIS_TTS_OPENAI_VOICE")

    # --- Google Workspace ----------------------------------------------------
    google_client_id: str = Field(default="", alias="GOOGLE_CLIENT_ID")
    google_client_secret: str = Field(default="", alias="GOOGLE_CLIENT_SECRET")
    google_redirect_uri: str = Field(
        default="", alias="GOOGLE_REDIRECT_URI"
    )

    # --- Persistance ---------------------------------------------------------
    database_url: str = Field(default="sqlite:///data/jarvis.db", alias="JARVIS_DATABASE_URL")

    # --- Securite ------------------------------------------------------------
    encryption_key: str = Field(default="", alias="JARVIS_ENCRYPTION_KEY")
    auto_approve_max_level: int = Field(default=1, alias="JARVIS_AUTO_APPROVE_MAX_LEVEL")
    auto_send_email: bool = Field(default=False, alias="JARVIS_AUTO_SEND_EMAIL")

    # --- Feature flags -------------------------------------------------------
    feature_voice: bool = Field(default=True, alias="JARVIS_FEATURE_VOICE")
    feature_wake_word: bool = Field(default=False, alias="JARVIS_FEATURE_WAKE_WORD")
    feature_gmail: bool = Field(default=False, alias="JARVIS_FEATURE_GMAIL")
    feature_calendar: bool = Field(default=False, alias="JARVIS_FEATURE_CALENDAR")
    feature_documents: bool = Field(default=False, alias="JARVIS_FEATURE_DOCUMENTS")
    feature_persistent_memory: bool = Field(
        default=True, alias="JARVIS_FEATURE_PERSISTENT_MEMORY"
    )
    feature_computer_control: bool = Field(default=False, alias="JARVIS_FEATURE_COMPUTER_CONTROL")
    feature_autonomous_mode: bool = Field(default=False, alias="JARVIS_FEATURE_AUTONOMOUS_MODE")

    @field_validator("auto_approve_max_level")
    @classmethod
    def _check_level(cls, value: int) -> int:
        if not 0 <= value <= 2:
            # Les paliers 3 et 4 exigent toujours une confirmation humaine:
            # on refuse categoriquement de les auto-approuver par configuration.
            raise ValueError(
                "JARVIS_AUTO_APPROVE_MAX_LEVEL doit etre entre 0 et 2 "
                "(les paliers 3 et 4 exigent toujours une confirmation)."
            )
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_dev(self) -> bool:
        return self.env == "development"

    @property
    def google_configured(self) -> bool:
        """Vrai si les identifiants OAuth Google sont renseignes."""
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def google_callback_url(self) -> str:
        """URI de redirection OAuth; deduite du serveur local si non forcee."""
        if self.google_redirect_uri:
            return self.google_redirect_uri
        return f"http://{self.host}:{self.port}/api/integrations/google/callback"

    @property
    def sqlite_path(self) -> str:
        """Chemin de fichier extrait d'une URL `sqlite:///...`."""
        if not self.database_url.startswith("sqlite:///"):
            raise ConfigurationError(
                f"Seul sqlite:/// est supporte pour l'instant (recu: {self.database_url})"
            )
        return self.database_url[len("sqlite:///") :]

    def feature_map(self) -> dict[str, bool]:
        """Etat des feature flags, expose a l'interface."""
        return {
            "voice": self.feature_voice,
            "wake_word": self.feature_wake_word,
            "gmail": self.feature_gmail,
            "calendar": self.feature_calendar,
            "documents": self.feature_documents,
            "persistent_memory": self.feature_persistent_memory,
            "computer_control": self.feature_computer_control,
            "autonomous_mode": self.feature_autonomous_mode,
        }



@functools.lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Retourne la configuration (mise en cache pour tout le processus)."""
    return Settings()


def reset_settings_cache() -> None:
    """Vide le cache de configuration (utilise par les tests)."""
    get_settings.cache_clear()
