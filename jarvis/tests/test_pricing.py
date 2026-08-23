"""Tests de l'estimation de cout.

Enjeu concret: l'API renvoie l'identifiant resolu du modele, souvent date
(`claude-haiku-4-5-20251001`). Si la table de tarifs ne le reconnait pas, le
cout est estime a zero et le budget quotidien cesse de proteger quoi que ce
soit. Ces tests verrouillent la normalisation.
"""

from __future__ import annotations

import pytest

from jarvis_core.config import Settings
from jarvis_core.errors import BudgetExceededError
from jarvis_core.llm.base import Usage
from jarvis_core.llm.pricing import PRICES, estimate_cost_usd, normalize_model
from jarvis_core.llm.router import SpendTracker


@pytest.mark.parametrize(
    ("returned", "expected"),
    [
        ("claude-haiku-4-5", "claude-haiku-4-5"),
        ("claude-haiku-4-5-20251001", "claude-haiku-4-5"),
        ("claude-opus-5-20260115", "claude-opus-5"),
        ("anthropic.claude-opus-5", "claude-opus-5"),
        ("us.anthropic.claude-sonnet-5-20260101", "claude-sonnet-5"),
    ],
)
def test_returned_model_ids_map_to_a_known_price(returned: str, expected: str) -> None:
    assert normalize_model(returned) == expected
    assert normalize_model(returned) in PRICES


def test_dated_model_is_billed_like_its_base_model() -> None:
    usage = Usage(input_tokens=1_000_000, output_tokens=1_000_000)
    dated = estimate_cost_usd("claude-haiku-4-5-20251001", usage)
    base = estimate_cost_usd("claude-haiku-4-5", usage)
    assert dated == base
    assert dated > 0, "un modele date ne doit jamais couter zero"


def test_free_engines_are_silent(caplog) -> None:  # type: ignore[no-untyped-def]
    """Le moteur local n'a pas de tarif: ce n'est pas une anomalie a signaler."""
    import logging

    with caplog.at_level(logging.WARNING, logger="jarvis_core.llm.pricing"):
        assert estimate_cost_usd("mock", Usage(input_tokens=10_000)) == 0.0
    assert caplog.records == []


def test_unknown_model_stays_at_zero_without_crashing() -> None:
    assert estimate_cost_usd("modele-inconnu-xyz", Usage(input_tokens=1000)) == 0.0


def test_cache_reads_cost_less_than_fresh_input() -> None:
    fresh = estimate_cost_usd("claude-opus-5", Usage(input_tokens=1_000_000))
    cached = estimate_cost_usd("claude-opus-5", Usage(cache_read_tokens=1_000_000))
    assert cached < fresh


def test_budget_actually_stops_calls_with_a_dated_model_id() -> None:
    """Le scenario reel: le budget doit couper meme si l'API renvoie une date."""
    tracker = SpendTracker(daily_budget_usd=0.5)
    tracker.check_budget()  # sous le plafond: passe
    tracker.record("claude-opus-5-20260115", Usage(input_tokens=1_000_000))
    with pytest.raises(BudgetExceededError):
        tracker.check_budget()


def test_zero_budget_means_unlimited() -> None:
    tracker = SpendTracker(daily_budget_usd=0.0)
    tracker.record("claude-opus-5", Usage(input_tokens=100_000_000))
    tracker.check_budget()  # ne doit pas lever


def test_spend_snapshot_reports_real_numbers() -> None:
    settings = Settings(JARVIS_LLM_DAILY_BUDGET_USD=10.0)
    tracker = SpendTracker(daily_budget_usd=settings.llm_daily_budget_usd)
    tracker.record("claude-opus-5-20260115", Usage(input_tokens=1_000_000, output_tokens=1000))
    snapshot = tracker.snapshot()
    assert snapshot["calls"] == 1
    assert float(snapshot["spent_usd"]) > 0
    assert snapshot["input_tokens"] == 1_000_000
