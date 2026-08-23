"""Ligne de commande de JARVIS.

    jarvis serve     lance l'API + l'interface
    jarvis chat      conversation en mode texte dans le terminal
    jarvis doctor    verifie la configuration et les dependances
    jarvis keygen    genere une cle de chiffrement pour .env

Le mode texte existe pour une raison precise: pouvoir deboguer le cerveau et
les outils sans dependre du micro ni du TTS.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from jarvis_core.config import Settings, get_settings
from jarvis_core.errors import ConfigurationError
from jarvis_core.logging_setup import setup_logging
from jarvis_core.security.crypto import SecretBox


def _cmd_serve(settings: Settings) -> int:
    import uvicorn

    uvicorn.run(
        "jarvis_core.api.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        reload=settings.is_dev,
    )
    return 0


async def _chat_loop(settings: Settings) -> int:
    from jarvis_core.orchestrator.events import EventType, JarvisEvent
    from jarvis_core.runtime import build_runtime

    runtime = build_runtime(settings)
    session = runtime.sessions.get_or_create()
    name = settings.jarvis_name

    print(f"— {name} en mode texte. Ctrl+C ou 'quit' pour sortir. —")
    print(
        f"  LLM: {runtime.router.provider.name} | "
        f"STT: {runtime.stt.name} | TTS: {runtime.tts.name}"
    )
    if runtime.router.provider.name == "mock":
        print("  (mode local sans modele de langage: capacites tres reduites)")
    print()

    async def sink(event: JarvisEvent) -> None:
        if event.type == EventType.TOOL_START:
            print(f"  · {event.payload['label']}…")
        elif event.type == EventType.TOOL_END:
            mark = "ok" if event.payload["ok"] else "echec"
            print(f"  · {event.payload['tool']}: {mark}")
        elif event.type == EventType.ERROR:
            print(f"  ! {event.payload['message']}")

    try:
        while True:
            try:
                text = input("vous > ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not text:
                continue
            if text.lower() in {"quit", "exit", "q"}:
                break
            result = await runtime.orchestrator.handle_text(session, text, sink=sink)
            print(f"{name.lower()} > {result.text}")
            if result.citations:
                for citation in result.citations:
                    print(f"        source: {citation.label}")
            print()
    finally:
        await runtime.aclose()
    return 0


def _cmd_sync_env() -> int:
    """Ajoute a `.env` les variables apparues dans `.env.example`."""
    from pathlib import Path

    from jarvis_core.config_sync import sync_env

    root = Path(__file__).resolve().parents[1]
    report = sync_env(root / ".env", root / ".env.example")

    if report.created:
        print(f".env cree a partir du modele ({len(report.added)} variables).")
        print("Remplis ANTHROPIC_API_KEY, puis relance: jarvis doctor")
        return 0
    if not report.added:
        print(f".env est a jour ({report.already_present} variables).")
        return 0

    print(f"{len(report.added)} variable(s) ajoutee(s) a .env:")
    for key in report.added:
        print(f"  + {key}")
    print("\nElles sont vides: ouvre .env et renseigne celles qui te concernent.")
    return 0


def _missing_env_keys() -> list[str]:
    """Variables du modele absentes de .env. Vide si tout est aligne."""
    from pathlib import Path

    from jarvis_core.config_sync import parse_keys

    root = Path(__file__).resolve().parents[1]
    env, example = root / ".env", root / ".env.example"
    if not env.is_file() or not example.is_file():
        return []
    existing = set(parse_keys(env.read_text(encoding="utf-8")))
    return [k for k in parse_keys(example.read_text(encoding="utf-8")) if k not in existing]


def _cmd_doctor(settings: Settings) -> int:
    """Diagnostic de configuration.

    Trois niveaux, volontairement distincts: `ok` (verifie), `info` (absent
    mais optionnel, JARVIS fonctionne quand meme), `ECHEC` (bloquant). Un
    echec renvoie un code de sortie non nul, exploitable en script.
    """
    import logging

    from jarvis_core.runtime import build_runtime

    # Le diagnostic doit se lire d'un coup d'oeil: on coupe le bruit des logs
    # applicatifs, on garde les avertissements.
    logging.getLogger().setLevel(logging.WARNING)

    OK, INFO, FAIL = "ok", "info", "fail"
    checks: list[tuple[str, str, str]] = []

    print("Verification de la configuration JARVIS\n")

    # -- bloquants -----------------------------------------------------------
    try:
        from jarvis_core.timeutils import get_tz

        get_tz(settings.timezone)
        checks.append(("Fuseau horaire", OK, settings.timezone))
    except ConfigurationError as exc:
        checks.append(("Fuseau horaire", FAIL, exc.user_message))

    missing = _missing_env_keys()
    if missing:
        checks.append(
            (
                "Fichier .env",
                INFO,
                f"{len(missing)} variable(s) du modele absentes "
                f"({', '.join(missing[:3])}{'…' if len(missing) > 3 else ''}) "
                "-> lance: jarvis sync-env",
            )
        )

    # -- securite ------------------------------------------------------------
    if settings.encryption_key:
        checks.append(("Cle de chiffrement", OK, "definie"))
    elif settings.is_dev:
        checks.append(
            ("Cle de chiffrement", INFO, "absente (cle ephemere, developpement)")
        )
    else:
        checks.append(
            ("Cle de chiffrement", FAIL, "absente: requise en production (jarvis keygen)")
        )

    # -- raisonnement --------------------------------------------------------
    if settings.llm_provider == "anthropic":
        if settings.anthropic_api_key:
            checks.append(("Cle Claude", OK, "definie"))
        else:
            checks.append(
                ("Cle Claude", INFO, "absente -> repli sur le moteur local, tres limite")
            )
    else:
        checks.append(("Moteur LLM", INFO, f"{settings.llm_provider} (pas de vrai modele)"))

    # -- voix (optionnelle) --------------------------------------------------
    checks.append(
        (
            "Moteur STT",
            OK if settings.stt_provider != "null" else INFO,
            settings.stt_provider
            if settings.stt_provider != "null"
            else "aucun -> micro desactive, le mode texte fonctionne",
        )
    )
    checks.append(
        (
            "Moteur TTS",
            OK if settings.tts_provider != "null" else INFO,
            settings.tts_provider
            if settings.tts_provider != "null"
            else "aucun -> voix du systeme cote client",
        )
    )

    # -- runtime -------------------------------------------------------------
    try:
        runtime = build_runtime(settings)
    except Exception as exc:  # noqa: BLE001 - le diagnostic doit survivre a tout
        checks.append(("Demarrage", FAIL, str(exc)))
        _print_checks(checks)
        return 1

    try:
        features = settings.feature_map()
        checks.append(("Base de donnees", OK, settings.database_url))
        checks.append(
            (
                "Outils disponibles",
                OK,
                f"{len(runtime.registry.available(features))} actifs"
                f" / {len(runtime.registry.all())} declares",
            )
        )
    finally:
        runtime.db.close()

    failed = _print_checks(checks)
    if settings.dry_run:
        print("\nMode developpement: les actions externes sont simulees.")
    if failed:
        print("\nCorrige les lignes [ECHEC] avant de lancer JARVIS.")
        return 1
    return 0


def _print_checks(checks: list[tuple[str, str, str]]) -> bool:
    """Affiche les verifications; retourne vrai si l'une d'elles est bloquante."""
    marks = {"ok": " ok  ", "info": "info ", "fail": "ECHEC"}
    failed = False
    for label, status, detail in checks:
        if status == "fail":
            failed = True
        print(f"  [{marks[status]}] {label:22} {detail}")
    return failed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis", description="Assistant personnel JARVIS")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("serve", help="lance l'API et l'interface")
    sub.add_parser("chat", help="conversation en mode texte")
    sub.add_parser("doctor", help="verifie la configuration")
    sub.add_parser("sync-env", help="ajoute a .env les nouvelles variables du modele")
    sub.add_parser("keygen", help="genere une cle de chiffrement")

    args = parser.parse_args(argv)
    settings = get_settings()
    setup_logging(settings.log_level)

    if args.command == "keygen":
        print(SecretBox.generate_key())
        return 0
    if args.command == "chat":
        return asyncio.run(_chat_loop(settings))
    if args.command == "sync-env":
        return _cmd_sync_env()
    if args.command == "doctor":
        return _cmd_doctor(settings)
    if args.command == "serve" or args.command is None:
        return _cmd_serve(settings)
    parser.print_help()
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
