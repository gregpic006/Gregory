"""Mise a jour depuis l'interface.

Ce module execute des commandes: ces tests verrouillent qu'il refuse de le
faire quand la situation n'est pas nette, plutot que d'ecraser du travail.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from jarvis_core.updater import (
    RESTART_EXIT_CODE,
    apply_update,
    check_update,
    find_repo_root,
)


def _run(cwd: Path, *args: str) -> None:
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    """Un depot distant, et une copie locale en retard de deux commits."""
    origin = tmp_path / "origine"
    origin.mkdir()
    _run(origin, "git", "init", "-q")
    _run(origin, "git", "config", "user.email", "t@t.co")
    _run(origin, "git", "config", "user.name", "T")
    (origin / "fichier.txt").write_text("v1")
    _run(origin, "git", "add", "-A")
    _run(origin, "git", "commit", "-qm", "premiere version")

    copy = tmp_path / "copie"
    _run(tmp_path, "git", "clone", "-q", str(origin), str(copy))
    _run(copy, "git", "config", "user.email", "t@t.co")
    _run(copy, "git", "config", "user.name", "T")

    (origin / "fichier.txt").write_text("v2")
    _run(origin, "git", "commit", "-qam", "amelioration du briefing")
    (origin / "autre.txt").write_text("v3")
    _run(origin, "git", "add", "-A")
    _run(origin, "git", "commit", "-qm", "correction du dossier surveille")
    return copy


def test_an_available_update_is_detected(clone: Path) -> None:
    status = check_update(clone)

    assert status.available is True
    assert status.behind == 2
    assert status.clean is True
    # Les messages sont montres a l'utilisateur: il doit savoir ce qui change.
    assert "amelioration du briefing" in status.changes


def test_applying_brings_the_new_files(clone: Path) -> None:
    result = apply_update(clone, build=False)

    assert result.updated is True
    assert (clone / "fichier.txt").read_text() == "v2"
    assert (clone / "autre.txt").exists()


def test_nothing_left_to_do_after_updating(clone: Path) -> None:
    apply_update(clone, build=False)

    assert check_update(clone).available is False


def test_up_to_date_is_not_an_error(clone: Path) -> None:
    apply_update(clone, build=False)

    result = apply_update(clone, build=False)

    assert result.updated is False
    assert result.error == ""
    assert "a jour" in result.detail


def test_local_changes_block_the_update(clone: Path) -> None:
    """Mettre a jour ecraserait le travail en cours: on refuse."""
    (clone / "fichier.txt").write_text("mon travail en cours")

    status = check_update(clone)

    assert status.clean is False
    assert "ecraserait" in status.blocked

    result = apply_update(clone, build=False)
    assert result.updated is False
    assert result.error
    # Le travail local a survecu.
    assert (clone / "fichier.txt").read_text() == "mon travail en cours"


def test_a_diverged_history_is_refused(clone: Path) -> None:
    """Une fusion automatique fabriquerait un historique que personne n'a voulu."""
    (clone / "local.txt").write_text("commit local")
    _run(clone, "git", "add", "-A")
    _run(clone, "git", "commit", "-qm", "travail local")

    result = apply_update(clone, build=False)

    assert result.updated is False
    assert "manuelle" in result.error


def test_a_folder_without_git_is_named_not_crashed(tmp_path: Path) -> None:
    status = check_update(tmp_path)

    assert status.available is False
    assert "depot git" in status.blocked


def test_the_repository_root_is_found_from_a_subfolder(clone: Path) -> None:
    """Selon le clonage, jarvis/ est la racine ou un sous-dossier."""
    nested = clone / "jarvis" / "ui"
    nested.mkdir(parents=True)

    assert find_repo_root(nested) == clone
    assert check_update(nested).available is True


# --------------------------------------------------- la boucle de redemarrage


def _scripts_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "scripts"


def test_both_start_scripts_use_the_agreed_exit_code() -> None:
    """Le code 42 est un contrat entre le serveur et les scripts.

    S'il change d'un cote sans l'autre, JARVIS s'arrete au lieu de redemarrer
    apres une mise a jour — silencieusement.
    """
    for name in ("start.sh", "start.ps1"):
        text = (_scripts_dir() / name).read_text(encoding="utf-8")
        assert str(RESTART_EXIT_CODE) in text, f"{name} ignore le code de redemarrage"


def test_the_shell_restart_loop_survives_a_failing_exit_code(tmp_path: Path) -> None:
    """`set -e` faisait sortir le shell avant meme de lire le code de sortie.

    Sortir avec 42 est un echec aux yeux de bash: sous `set -euo pipefail`, la
    boucle `serve; code=$?` n'atteignait jamais sa deuxieme ligne. JARVIS
    s'arretait donc apres chaque mise a jour au lieu de redemarrer.

    Ce test rejoue la boucle reelle de start.sh avec un faux serveur qui rend
    42 deux fois puis 0.
    """
    if shutil.which("bash") is None:  # pragma: no cover - depend de la machine
        pytest.skip("bash absent")

    loop = _extract_restart_loop(_scripts_dir() / "start.sh")
    # Le faux serveur remplace l'appel reel; `prepare` devient un no-op.
    fake = loop.replace(
        "./.venv/bin/python -m jarvis_core.cli serve",
        'n=$((n+1)); if [ "$n" -le 2 ]; then (exit 42); else (exit 0); fi',
    ).replace("prepare", "true")

    script = tmp_path / "loop.sh"
    script.write_text(f"set -euo pipefail\nn=0\n{fake}\n", encoding="utf-8")
    done = subprocess.run(
        ["bash", str(script)], capture_output=True, text=True, timeout=30, check=False
    )

    assert done.returncode == 0, done.stderr
    assert done.stdout.count("redemarrage") == 2


def _extract_restart_loop(path: Path) -> str:
    """Isole la boucle `while true` de start.sh, telle qu'elle est ecrite."""
    lines = path.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("while true"))
    end = next(i for i, line in enumerate(lines[start:], start) if line.rstrip() == "done")
    return "\n".join(lines[start : end + 1])
