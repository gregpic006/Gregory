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


def _cmd_doctor(settings: Settings) -> int:
    from jarvis_core.runtime import build_runtime

    print("Verification de la configuration JARVIS\n")
    checks: list[tuple[str, bool, str]] = []

    checks.append(("Fuseau horaire", True, settings.timezone))
    checks.append(
        (
            "Cle de chiffrement",
            bool(settings.encryption_key),
            "definie" if settings.encryption_key else "absente (cle ephemere en dev)",
        )
    )
    if settings.llm_provider == "anthropic":
        checks.append(
            (
                "Cle Claude",
                bool(settings.anthropic_api_key),
                "definie" if settings.anthropic_api_key else "absente -> repli sur le mode local",
            )
        )
    checks.append(
        ("Moteur STT", settings.stt_provider != "null", settings.stt_provider)
    )
    checks.append(
        (
            "Moteur TTS",
            settings.tts_provider != "null",
            f"{settings.tts_provider} (voix du systeme si null)",
        )
    )

    try:
        runtime = build_runtime(settings)
    except Exception as exc:  # noqa: BLE001
        print(f"  [ECHEC] Construction du runtime: {exc}")
        return 1

    features = settings.feature_map()
    checks.append(("Base de donnees", True, settings.database_url))
    checks.append(
        (
            "Outils disponibles",
            True,
            f"{len(runtime.registry.available(features))} actifs"
            f" / {len(runtime.registry.all())} declares",
        )
    )

    ok = True
    for label, passed, detail in checks:
        mark = " ok " if passed else "info"
        ok = ok and (passed or label not in {"Fuseau horaire", "Base de donnees"})
        print(f"  [{mark}] {label:22} {detail}")

    runtime.db.close()
    print("\nMode developpement: les actions externes sont simulees." if settings.dry_run else "")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis", description="Assistant personnel JARVIS")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("serve", help="lance l'API et l'interface")
    sub.add_parser("chat", help="conversation en mode texte")
    sub.add_parser("doctor", help="verifie la configuration")
    sub.add_parser("keygen", help="genere une cle de chiffrement")

    args = parser.parse_args(argv)
    settings = get_settings()
    setup_logging(settings.log_level)

    if args.command == "keygen":
        print(SecretBox.generate_key())
        return 0
    if args.command == "chat":
        return asyncio.run(_chat_loop(settings))
    if args.command == "doctor":
        return _cmd_doctor(settings)
    if args.command == "serve" or args.command is None:
        return _cmd_serve(settings)
    parser.print_help()
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
