"""Les paquets manquants: les installer, et surtout ne pas mentir dessus.

Une mise a jour peut ajouter une dependance. `git pull` recupere le code mais
n'installe rien: la fonctionnalite est alors morte en silence, et le message
d'erreur qui en decoule designe la mauvaise cause.

C'est arrive: la voix neuronale a ete ajoutee, le proprietaire a mis a jour, et
l'interface lui a repondu « verifie ta connexion » alors que sa connexion
allait tres bien.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from jarvis_core import deps


def test_a_present_package_is_seen_as_present() -> None:
    """`sys` est toujours la: c'est le controle du controle."""
    assert deps.is_installed("sys") is True


def test_an_absent_package_is_seen_as_absent() -> None:
    assert deps.is_installed("un_paquet_qui_n_existe_pas_du_tout") is False


def test_a_broken_module_name_is_not_a_crash() -> None:
    """`find_spec` leve sur certains noms invalides. Ce n'est pas fatal."""
    assert deps.is_installed("") is False


def test_nothing_is_installed_when_nothing_is_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Pas de pip a chaque demarrage quand tout est deja la."""
    called = False

    def watch(root: Path) -> tuple[bool, str]:
        nonlocal called
        called = True
        return True, ""

    monkeypatch.setattr(deps, "missing", list)
    monkeypatch.setattr(deps, "install_project", watch)

    assert deps.ensure_installed(tmp_path) == ([], "")
    assert called is False


def test_a_missing_package_triggers_an_install(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    want = deps.Requirement(module="paquet_absent", feature="la voix neuronale")
    calls: list[Path] = []
    healed = False

    def fake_missing() -> list[deps.Requirement]:
        return [] if healed else [want]

    def fake_install(root: Path) -> tuple[bool, str]:
        nonlocal healed
        calls.append(root)
        healed = True
        return True, "ok"

    monkeypatch.setattr(deps, "missing", fake_missing)
    monkeypatch.setattr(deps, "install_project", fake_install)

    installed, error = deps.ensure_installed(tmp_path)
    assert installed == [want]
    assert error == ""
    assert calls == [tmp_path]


def test_an_install_that_does_not_actually_install_is_reported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """pip peut sortir en succes sans avoir installe ce qu'on attendait.

    Croire le code de retour laisserait JARVIS annoncer que tout va bien avec
    une fonctionnalite toujours morte.
    """
    want = deps.Requirement(module="paquet_absent", feature="la voix neuronale")
    monkeypatch.setattr(deps, "missing", lambda: [want])
    monkeypatch.setattr(deps, "install_project", lambda root: (True, "ok"))

    installed, error = deps.ensure_installed(tmp_path)
    assert installed == [want]
    assert "paquet_absent" in error


def test_installing_without_a_pyproject_is_refused(tmp_path: Path) -> None:
    """Rien a installer depuis un dossier qui n'est pas le projet."""
    ok, message = deps.install_project(tmp_path)
    assert ok is False
    assert "pyproject" in message


def test_the_install_command_is_a_constant(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Ce module lance pip: aucun nom venant d'ailleurs ne doit y entrer."""
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
    seen: dict[str, Any] = {}

    class Done:
        returncode = 0
        stdout = ""
        stderr = ""

    def spy(command: list[str], **kwargs: Any) -> Done:
        seen["command"] = command
        seen["shell"] = kwargs.get("shell", False)
        return Done()

    monkeypatch.setattr(deps.subprocess, "run", spy)
    deps.install_project(tmp_path)

    assert seen["command"][1:] == ["-m", "pip", "install", "-e", ".", "--quiet"]
    assert seen["shell"] is False


# ------------------------------------------------------- le message affiche


def test_a_missing_package_is_not_blamed_on_the_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Le defaut qui a coute le plus de temps a l'utilisateur.

    « Verifie ta connexion » envoyait debugger un routeur alors qu'il
    manquait un paquet Python.
    """
    from fastapi.testclient import TestClient

    from jarvis_core.api.app import create_app
    from jarvis_core.voice.tts import edge_tts_provider

    monkeypatch.setenv("JARVIS_TTS_PROVIDER", "edge")
    monkeypatch.setattr(edge_tts_provider, "_edge_tts", lambda: None)
    monkeypatch.setattr("jarvis_core.deps.is_installed", lambda module: False)

    with TestClient(create_app()) as client:
        error = client.get("/api/settings/voice").json()["error"]

    assert "connexion" not in error.lower()
    assert "install" in error.lower()


def test_an_unreachable_service_still_blames_the_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """L'autre moitie du diagnostic doit rester juste."""
    from fastapi.testclient import TestClient

    from jarvis_core.api.app import create_app
    from jarvis_core.voice.tts import edge_tts_provider

    class Unreachable:
        @staticmethod
        async def list_voices() -> list[dict[str, Any]]:
            raise OSError("reseau coupe")

    monkeypatch.setenv("JARVIS_TTS_PROVIDER", "edge")
    monkeypatch.setattr(edge_tts_provider, "_edge_tts", lambda: Unreachable)
    monkeypatch.setattr("jarvis_core.deps.is_installed", lambda module: True)

    with TestClient(create_app()) as client:
        error = client.get("/api/settings/voice").json()["error"]

    assert "connexion" in error.lower()
