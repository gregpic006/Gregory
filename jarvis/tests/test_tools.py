"""Tests des outils integres et de la validation de leurs parametres."""

from __future__ import annotations

import pytest

from jarvis_core.config import Settings
from jarvis_core.errors import ToolValidationError
from jarvis_core.memory.session import SessionMemory
from jarvis_core.memory.store import MemoryStore
from jarvis_core.persistence.db import Database
from jarvis_core.persistence.repositories import ReminderRepository
from jarvis_core.tools.base import ToolContext
from jarvis_core.tools.registry import registry
from jarvis_core.tools.schema import validate_arguments


@pytest.fixture()
def ctx(settings: Settings, db: Database) -> ToolContext:
    return ToolContext(
        session_id="s1",
        settings=settings,
        session=SessionMemory("s1"),
        memory_store=MemoryStore(db),
        reminders=ReminderRepository(db),
        dry_run=True,
    )


async def test_calculate_handles_taxes(ctx: ToolContext) -> None:
    result = await registry.execute("calculate", {"expression": "1250.50 * 1.14975"}, ctx)
    assert result.ok
    assert abs(result.data["result"] - 1437.7624) < 0.01


async def test_calculate_rejects_code_execution(ctx: ToolContext) -> None:
    """L'evaluateur n'execute jamais de code arbitraire."""
    result = await registry.execute(
        "calculate", {"expression": "__import__('os').system('echo pwned')"}, ctx
    )
    assert not result.ok


async def test_calculate_handles_division_by_zero(ctx: ToolContext) -> None:
    result = await registry.execute("calculate", {"expression": "1/0"}, ctx)
    assert not result.ok


async def test_resolve_date_returns_a_precise_window(ctx: ToolContext) -> None:
    result = await registry.execute("resolve_date", {"expression": "demain"}, ctx)
    assert result.ok
    assert "start" in result.data and "end" in result.data


async def test_resolve_date_admits_when_it_does_not_know(ctx: ToolContext) -> None:
    result = await registry.execute("resolve_date", {"expression": "un jour peut-etre"}, ctx)
    assert not result.ok
    assert "ne devine pas" in result.summary


async def test_reminder_lifecycle(ctx: ToolContext) -> None:
    created = await registry.execute(
        "create_reminder", {"text": "appeler le comptable", "when": "demain matin"}, ctx
    )
    assert created.ok
    listed = await registry.execute("list_reminders", {}, ctx)
    assert "appeler le comptable" in listed.summary
    # La liste devient le focus: "le premier" doit etre resolvable ensuite.
    assert ctx.session.resolve_reference("le premier") is not None

    done = await registry.execute(
        "complete_reminder", {"reminder_id": created.data["id"]}, ctx
    )
    assert done.ok
    empty = await registry.execute("list_reminders", {}, ctx)
    assert "Aucun rappel" in empty.summary


async def test_memory_requires_a_source(ctx: ToolContext) -> None:
    stored = await registry.execute(
        "remember_fact",
        {"fact": "Xavier detient 30 % de Portail", "subject": "Xavier", "kind": "business"},
        ctx,
    )
    assert stored.ok
    found = await registry.execute("recall_memory", {"query": "Xavier Portail"}, ctx)
    assert "Xavier" in found.summary
    assert found.citations, "un souvenir doit toujours etre citable"


async def test_recall_says_nothing_found_instead_of_inventing(ctx: ToolContext) -> None:
    result = await registry.execute("recall_memory", {"query": "le trésor de Barbe-Noire"}, ctx)
    assert result.ok
    assert "Rien en memoire" in result.summary


async def test_capabilities_reports_missing_integrations(ctx: ToolContext) -> None:
    result = await registry.execute("get_capabilities", {}, ctx)
    assert "Gmail" in result.summary
    assert "Pas encore connecte" in result.summary


async def test_unknown_parameters_are_dropped(ctx: ToolContext) -> None:
    result = await registry.execute(
        "calculate", {"expression": "2+2", "sudo": True, "shell": "rm -rf /"}, ctx
    )
    assert result.ok
    assert result.data["result"] == 4


def test_missing_required_parameter_is_rejected() -> None:
    schema = {
        "type": "object",
        "properties": {"expression": {"type": "string"}},
        "required": ["expression"],
    }
    with pytest.raises(ToolValidationError):
        validate_arguments(schema, {})


def test_wrong_type_is_rejected() -> None:
    schema = {"type": "object", "properties": {"limit": {"type": "integer"}}}
    with pytest.raises(ToolValidationError):
        validate_arguments(schema, {"limit": "beaucoup"})


def test_enum_is_enforced() -> None:
    schema = {"type": "object", "properties": {"kind": {"type": "string", "enum": ["a", "b"]}}}
    with pytest.raises(ToolValidationError):
        validate_arguments(schema, {"kind": "c"})


def test_bounds_are_enforced() -> None:
    schema = {"type": "object", "properties": {"limit": {"type": "integer", "maximum": 10}}}
    with pytest.raises(ToolValidationError):
        validate_arguments(schema, {"limit": 999})


def test_gmail_tools_are_hidden_when_the_flag_is_off(settings: Settings) -> None:
    available = {tool.name for tool in registry.available(settings.feature_map())}
    assert "search_email" not in available
    assert "get_current_time" in available


def test_gmail_tools_appear_when_the_flag_is_on() -> None:
    features = Settings(JARVIS_FEATURE_GMAIL=True).feature_map()
    available = {tool.name for tool in registry.available(features)}
    assert "search_email" in available
