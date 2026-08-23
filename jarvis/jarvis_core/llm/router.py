"""Routage de modele et controle de cout.

Le routeur choisit le modele en fonction du niveau de complexite demande, suit
la depense cumulee de la journee et coupe net au-dela du budget configure.
Objectif: ne jamais payer un modele haut de gamme pour repondre "il est quelle
heure".
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date

from jarvis_core.config import Settings
from jarvis_core.errors import BudgetExceededError
from jarvis_core.llm.base import (
    LLMMessage,
    LLMProvider,
    LLMResponse,
    StreamCallback,
    TaskTier,
    ToolSpec,
    Usage,
)
from jarvis_core.llm.pricing import estimate_cost_usd

logger = logging.getLogger(__name__)


@dataclass
class SpendTracker:
    """Suivi de depense LLM, remis a zero chaque jour."""

    daily_budget_usd: float = 0.0
    _day: date = field(default_factory=date.today)
    _spent: float = 0.0
    _calls: int = 0
    _usage: Usage = field(default_factory=Usage)

    def _roll_day(self) -> None:
        today = date.today()
        if today != self._day:
            self._day = today
            self._spent = 0.0
            self._calls = 0
            self._usage = Usage()

    def check_budget(self) -> None:
        """Leve `BudgetExceededError` si le budget du jour est epuise."""
        self._roll_day()
        if self.daily_budget_usd > 0 and self._spent >= self.daily_budget_usd:
            raise BudgetExceededError(
                f"budget quotidien atteint: {self._spent:.2f} / {self.daily_budget_usd:.2f} USD"
            )

    def record(self, model: str, usage: Usage) -> float:
        self._roll_day()
        cost = estimate_cost_usd(model, usage)
        self._spent += cost
        self._calls += 1
        self._usage = self._usage + usage
        return cost

    def snapshot(self) -> dict[str, object]:
        self._roll_day()
        return {
            "day": self._day.isoformat(),
            "spent_usd": round(self._spent, 4),
            "budget_usd": self.daily_budget_usd,
            "calls": self._calls,
            "input_tokens": self._usage.input_tokens,
            "output_tokens": self._usage.output_tokens,
            "cache_read_tokens": self._usage.cache_read_tokens,
        }


@dataclass(frozen=True)
class TierConfig:
    """Modele et profondeur de raisonnement associes a un niveau."""

    model: str
    effort: str | None


class LLMRouter:
    """Facade unique utilisee par l'orchestrateur pour parler au LLM."""

    def __init__(self, provider: LLMProvider, settings: Settings) -> None:
        self.provider = provider
        self.settings = settings
        self.spend = SpendTracker(daily_budget_usd=settings.llm_daily_budget_usd)
        self._tiers: dict[TaskTier, TierConfig] = {
            # `low` garde la latence basse pour la conversation vocale.
            TaskTier.FAST: TierConfig(settings.llm_model_fast, "low"),
            TaskTier.BALANCED: TierConfig(settings.llm_model_balanced, "low"),
            TaskTier.DEEP: TierConfig(settings.llm_model_deep, "high"),
        }

    def model_for(self, tier: TaskTier) -> str:
        return self._tiers[tier].model

    async def complete(
        self,
        *,
        tier: TaskTier,
        system: str,
        messages: list[LLMMessage],
        tools: list[ToolSpec] | None = None,
        max_tokens: int | None = None,
        on_text: StreamCallback | None = None,
    ) -> LLMResponse:
        """Appelle le fournisseur en respectant le budget."""
        self.spend.check_budget()
        config = self._tiers[tier]
        response = await self.provider.complete(
            model=config.model,
            system=system,
            messages=messages,
            tools=tools,
            max_tokens=max_tokens or self.settings.llm_max_tokens,
            effort=config.effort,
            on_text=on_text,
        )
        cost = self.spend.record(response.model or config.model, response.usage)
        logger.debug(
            "LLM %s tier=%s latence=%dms cout=%.5f USD",
            response.model,
            tier.value,
            response.latency_ms,
            cost,
        )
        return response

    async def aclose(self) -> None:
        await self.provider.aclose()


def build_provider(settings: Settings) -> LLMProvider:
    """Instancie le fournisseur declare en configuration."""
    if settings.llm_provider == "mock":
        from jarvis_core.llm.mock_provider import MockLLMProvider

        return MockLLMProvider(
            jarvis_name=settings.jarvis_name, user_name=settings.user_name
        )
    from jarvis_core.llm.anthropic_provider import AnthropicProvider

    return AnthropicProvider(settings.anthropic_api_key)


def build_router(settings: Settings) -> LLMRouter:
    """Construit le routeur; bascule sur le mode local si la cle est absente."""
    if settings.llm_provider == "anthropic" and not settings.anthropic_api_key:
        logger.warning(
            "ANTHROPIC_API_KEY absente: bascule sur le fournisseur local 'mock'. "
            "Les capacites de raisonnement sont tres reduites."
        )
        from jarvis_core.llm.mock_provider import MockLLMProvider

        provider: LLMProvider = MockLLMProvider(
            jarvis_name=settings.jarvis_name, user_name=settings.user_name
        )
    else:
        provider = build_provider(settings)
    return LLMRouter(provider, settings)
