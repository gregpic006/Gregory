"""Tests de la memoire de conversation."""

from __future__ import annotations

from jarvis_core.llm.base import ToolCall, ToolResultBlock
from jarvis_core.memory.session import ReferencedItem, SessionMemory, SessionStore


def _meetings() -> list[ReferencedItem]:
    return [
        ReferencedItem(kind="meeting", ref_id="m1", label="8 h 30 — comptable"),
        ReferencedItem(kind="meeting", ref_id="m2", label="10 h — Xavier"),
        ReferencedItem(kind="meeting", ref_id="m3", label="14 h — notaire"),
    ]


def test_ordinal_reference_resolution() -> None:
    session = SessionMemory("s1")
    session.set_focus("meeting", _meetings())
    assert session.resolve_reference("le deuxieme est avec qui?").ref_id == "m2"
    assert session.resolve_reference("le troisième, c'est quoi?").ref_id == "m3"
    assert session.resolve_reference("le dernier").ref_id == "m3"
    assert session.resolve_reference("le premier").ref_id == "m1"


def test_numeric_reference_resolution() -> None:
    session = SessionMemory("s1")
    session.set_focus("meeting", _meetings())
    assert session.resolve_reference("le numero 2").ref_id == "m2"


def test_ambiguous_reference_returns_none() -> None:
    """Avec plusieurs candidats et aucun indice, on ne devine pas."""
    session = SessionMemory("s1")
    session.set_focus("meeting", _meetings())
    assert session.resolve_reference("deplace-le a 15 h") is None


def test_single_item_focus_resolves_pronoun() -> None:
    session = SessionMemory("s1")
    session.set_focus("meeting", _meetings()[:1])
    assert session.resolve_reference("deplace-le a 15 h").ref_id == "m1"


def test_focus_block_is_injected_for_the_model() -> None:
    session = SessionMemory("s1")
    session.set_focus("meeting", _meetings())
    block = session.focus_block()
    assert "1. [m1]" in block
    assert "le deuxieme" in block


def test_trimming_keeps_a_valid_conversation_start() -> None:
    """Apres troncature, l'historique commence par un vrai message utilisateur."""
    session = SessionMemory("s1", max_messages=4)
    for index in range(6):
        session.add_user_text(f"question {index}")
        session.add_assistant(f"reponse {index}")
    history = session.history()
    assert len(history) <= 4
    assert history[0].role == "user"
    assert not any(isinstance(b, ToolResultBlock) for b in history[0].content)


def test_trimming_never_leaves_an_orphan_tool_result() -> None:
    session = SessionMemory("s1", max_messages=2)
    session.add_user_text("cherche")
    session.add_assistant("", [ToolCall(id="t1", name="search_email", arguments={})])
    session.add_tool_results([ToolResultBlock(tool_call_id="t1", content="rien")])
    history = session.history()
    if history:
        assert history[0].role == "user"
        assert not any(isinstance(b, ToolResultBlock) for b in history[0].content)


def test_session_store_creates_and_reuses_sessions() -> None:
    store = SessionStore()
    first = store.get_or_create()
    again = store.get_or_create(first.session_id)
    assert first is again
    assert store.count() == 1
    store.drop(first.session_id)
    assert store.count() == 0
