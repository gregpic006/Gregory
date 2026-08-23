"""Tests de la reconciliation .env / .env.example.

Situation reelle qui a motive ce module: un `.env` cree avant un jalon ne
recoit jamais les variables ajoutees depuis, parce que git ne le suit pas.
L'integration semblait alors « non configuree » sans explication.

Invariant absolu: aucune valeur existante n'est modifiee, aucune cle
supprimee. Le fichier de l'utilisateur ne peut que gagner des lignes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jarvis_core.config_sync import parse_keys, sync_env

EXAMPLE = """\
# JARVIS - modele
JARVIS_NAME=Jarvis
# Cle Claude
ANTHROPIC_API_KEY=

# --- Google ---
# Identifiants OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

JARVIS_FEATURE_GMAIL=false
"""


@pytest.fixture()
def example(tmp_path: Path) -> Path:
    path = tmp_path / ".env.example"
    path.write_text(EXAMPLE, encoding="utf-8")
    return path


def test_keys_are_extracted_ignoring_comments() -> None:
    keys = parse_keys(EXAMPLE)
    assert keys == [
        "JARVIS_NAME", "ANTHROPIC_API_KEY", "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET", "JARVIS_FEATURE_GMAIL",
    ]


def test_commented_out_keys_are_not_counted() -> None:
    assert parse_keys("# GOOGLE_CLIENT_ID=abc\nJARVIS_NAME=x") == ["JARVIS_NAME"]


def test_missing_keys_are_appended(tmp_path: Path, example: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("JARVIS_NAME=Jarvis\nANTHROPIC_API_KEY=sk-ant-secret\n", encoding="utf-8")

    report = sync_env(env, example)

    assert set(report.added) == {
        "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "JARVIS_FEATURE_GMAIL"
    }
    assert set(parse_keys(env.read_text(encoding="utf-8"))) >= set(parse_keys(EXAMPLE))


def test_existing_secrets_are_never_touched(tmp_path: Path, example: Path) -> None:
    """L'invariant qui compte: on n'ecrase jamais une valeur deja renseignee."""
    env = tmp_path / ".env"
    env.write_text(
        "JARVIS_NAME=MonAssistant\nANTHROPIC_API_KEY=sk-ant-ma-vraie-cle\n", encoding="utf-8"
    )

    sync_env(env, example)

    content = env.read_text(encoding="utf-8")
    assert "ANTHROPIC_API_KEY=sk-ant-ma-vraie-cle" in content
    assert "JARVIS_NAME=MonAssistant" in content
    assert "JARVIS_NAME=Jarvis" not in content, "la valeur du modele ne doit pas s'imposer"


def test_a_key_already_present_but_empty_is_left_alone(
    tmp_path: Path, example: Path
) -> None:
    env = tmp_path / ".env"
    env.write_text("GOOGLE_CLIENT_ID=\n", encoding="utf-8")
    report = sync_env(env, example)
    assert "GOOGLE_CLIENT_ID" not in report.added
    assert env.read_text(encoding="utf-8").count("GOOGLE_CLIENT_ID") == 1


def test_running_twice_changes_nothing(tmp_path: Path, example: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("JARVIS_NAME=Jarvis\n", encoding="utf-8")

    sync_env(env, example)
    after_first = env.read_text(encoding="utf-8")
    second = sync_env(env, example)

    assert second.added == []
    assert env.read_text(encoding="utf-8") == after_first


def test_comments_travel_with_the_keys(tmp_path: Path, example: Path) -> None:
    """Une variable sans son commentaire est une variable qu'on ne remplira pas."""
    env = tmp_path / ".env"
    env.write_text("JARVIS_NAME=Jarvis\n", encoding="utf-8")
    sync_env(env, example)
    assert "Identifiants OAuth" in env.read_text(encoding="utf-8")


def test_absent_env_is_created_from_the_template(tmp_path: Path, example: Path) -> None:
    env = tmp_path / ".env"
    report = sync_env(env, example)
    assert report.created is True
    assert env.read_text(encoding="utf-8") == EXAMPLE


def test_missing_template_is_an_explicit_error(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        sync_env(tmp_path / ".env", tmp_path / "absent.example")


def test_the_shipped_template_stays_in_sync_with_settings() -> None:
    """Garde-fou: toute variable lue par Settings doit exister dans le modele.

    Sans ce test, ajouter un reglage sans l'exposer dans `.env.example` le
    rendrait invisible pour l'utilisateur.
    """
    from jarvis_core.config import Settings

    root = Path(__file__).resolve().parents[1]
    documented = set(parse_keys((root / ".env.example").read_text(encoding="utf-8")))
    used = {
        field.alias
        for field in Settings.model_fields.values()
        if field.alias
    }
    assert used - documented == set(), "variables lues mais absentes de .env.example"
