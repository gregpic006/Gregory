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
from pathlib import Path

from jarvis_core.config import Settings, get_settings
from jarvis_core.errors import ConfigurationError, DocumentError, JarvisError
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


async def _cmd_check_google(settings: Settings) -> int:
    """Teste la chaine Google directement, pour distinguer les causes."""
    import logging

    from jarvis_core.diagnostics import check_google, render
    from jarvis_core.runtime import build_runtime

    logging.getLogger().setLevel(logging.WARNING)
    print("Diagnostic Google Workspace\n")
    runtime = build_runtime(settings)
    try:
        failed = render(await check_google(runtime))
    finally:
        await runtime.aclose()

    if failed:
        print("\nCorrige les lignes [ECHEC] ci-dessus.")
        return 1
    print("\nTout repond. Si JARVIS n'utilise pas ces donnees, c'est le modele")
    print("qui n'appelle pas l'outil: reformule ta demande plus explicitement.")
    return 0


async def _cmd_check_voice(settings: Settings) -> int:
    """Teste le pipeline vocal cote serveur, sans micro."""
    import logging

    from jarvis_core.diagnostics import check_voice, render
    from jarvis_core.runtime import build_runtime

    logging.getLogger().setLevel(logging.WARNING)
    print("Diagnostic vocal\n")
    runtime = build_runtime(settings)
    try:
        failed = render(await check_voice(runtime))
    finally:
        await runtime.aclose()

    if failed:
        print("\nCorrige les lignes [ECHEC] ci-dessus, puis redemarre l'API.")
        return 1
    print("\nLe serveur est pret. Si le micro ne repond pas dans l'interface:")
    print("  - l'adresse doit etre localhost (pas une IP), ou en HTTPS;")
    print("  - le navigateur doit avoir l'autorisation du micro;")
    print("  - l'API doit avoir ete redemarree apres modification de .env.")
    return 0


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


def _cmd_index(settings: Settings, path: str, force: bool) -> int:
    """Indexe un dossier de documents et rend compte, fichier par fichier."""
    from jarvis_core.documents.ingest import ingest_directory
    from jarvis_core.persistence.db import build_database
    from jarvis_core.runtime import build_document_store

    if not settings.feature_documents:
        print("[ECHEC] La recherche documentaire est desactivee.")
        print("        Mets JARVIS_FEATURE_DOCUMENTS=true dans le fichier .env.")
        return 1

    target = path or settings.documents_dir
    db = build_database(settings.database_url)
    db.migrate()
    store = build_document_store(settings, db)
    if store is None:  # pragma: no cover - deja couvert par le garde ci-dessus
        print("[ECHEC] Magasin documentaire indisponible.")
        return 1

    print(f"Dossier: {Path(target).expanduser().resolve()}")
    try:
        report = ingest_directory(store, target, force=force)
    except DocumentError as exc:
        print(f"[ECHEC] {exc.user_message}")
        return 1

    for name in report.indexed:
        print(f"  [indexe]    {name}")
    for name in report.unchanged:
        print(f"  [inchange]  {name}")
    for name, reason in report.skipped:
        print(f"  [ignore]    {name} — {reason}")
    for name, reason in report.failed:
        print(f"  [ECHEC]     {name} — {reason}")

    print(f"\n{report.summary()} ({report.chunk_total} passage(s) indexes).")
    print(f"Total dans l'index: {store.count()} document(s).")

    # Dire franchement quel type de recherche sera possible.
    if not settings.embedding_enabled:
        print("Recherche: lexicale (mots exacts). JARVIS_EMBEDDING_ENABLED=false.")
    elif store.embeddings is None:
        print(
            "Recherche: lexicale seulement — le modele semantique n'a pas pu etre charge.\n"
            "           Les documents restent trouvables par mots exacts."
        )
    else:
        print(f"Recherche: lexicale + semantique ({store.embeddings.name}).")
    db.close()
    return 1 if report.failed else 0


async def _cmd_sync_drive(settings: Settings, force: bool) -> int:
    """Indexe le dossier Drive configure et rend compte fichier par fichier."""
    from jarvis_core.documents.drive_sync import sync_drive
    from jarvis_core.runtime import build_runtime

    if not settings.feature_documents:
        print("[ECHEC] JARVIS_FEATURE_DOCUMENTS=false — la recherche documentaire est desactivee.")
        return 1
    if not settings.feature_drive:
        print("[ECHEC] JARVIS_FEATURE_DRIVE=false — l'acces a Drive est desactive.")
        return 1

    runtime = build_runtime(settings)
    try:
        if not runtime.google.connected:
            print("[ECHEC] Aucun compte Google connecte. Lance d'abord: jarvis check-google")
            return 1
        if runtime.documents is None:  # pragma: no cover - garde deja posee plus haut
            print("[ECHEC] Magasin documentaire indisponible.")
            return 1

        print(f"Dossier Drive: {settings.drive_folder}")
        try:
            report = await sync_drive(
                runtime.documents,
                runtime.google.drive,
                folder=settings.drive_folder,
                force=force,
            )
        except (DocumentError, JarvisError) as exc:
            print(f"[ECHEC] {exc.user_message}")
            return 1

        for name in report.indexed:
            print(f"  [indexe]    {name}")
        for name in report.unchanged:
            print(f"  [inchange]  {name}")
        for name, reason in report.skipped:
            print(f"  [ignore]    {name} — {reason}")
        for name, reason in report.failed:
            print(f"  [ECHEC]     {name} — {reason}")

        print(f"\n{report.summary()} ({report.chunk_total} passage(s) indexes).")
        print(f"Total dans l'index: {runtime.documents.count()} document(s).")
        return 1 if report.failed else 0
    finally:
        await runtime.aclose()


def _cmd_check_documents(settings: Settings) -> int:
    """Diagnostic de la recherche documentaire."""
    from jarvis_core.diagnostics import check_documents, render
    from jarvis_core.runtime import build_runtime

    runtime = build_runtime(settings)
    try:
        print("Verification de la recherche documentaire\n")
        return 0 if render(check_documents(runtime)) else 1
    finally:
        runtime.db.close()


def _cmd_import_business(settings: Settings, path: str, org: str, replace: bool) -> int:
    """Importe un CSV de donnees business et rend compte ligne par ligne."""
    from jarvis_core.business.csv_import import ImportError_, import_csv_file
    from jarvis_core.business.store import BusinessStore
    from jarvis_core.persistence.db import build_database

    if not settings.feature_business:
        print("[ECHEC] JARVIS_FEATURE_BUSINESS=false — les donnees business sont desactivees.")
        return 1

    db = build_database(settings.database_url)
    db.migrate()
    store = BusinessStore(db)

    row = db.query_one(
        "SELECT id, name, kind FROM organizations WHERE id = ? OR lower(name) = lower(?)",
        (org, org),
    )
    if row is None:
        known = db.query("SELECT id, name FROM organizations WHERE id != 'PERSONAL' ORDER BY name")
        print(f"[ECHEC] Entreprise inconnue: {org}")
        print("        Entreprises connues:")
        for entry in known:
            print(f"          {entry['id']:<20} {entry['name']}")
        db.close()
        return 1

    org_id, name, kind = str(row["id"]), str(row["name"]), str(row["kind"])
    if replace:
        removed = store.clear(org_id=org_id, source="csv")
        print(f"-> {removed} fait(s) precedents effaces pour {name}")

    try:
        report = import_csv_file(store, path, org_id=org_id, kind=kind)
    except ImportError_ as exc:
        print(f"[ECHEC] {exc.user_message}")
        db.close()
        return 1

    print(f"Entreprise: {name}")
    print(f"  {report.summary()}")
    if report.ignored_columns:
        print(f"  colonnes ignorees: {', '.join(report.ignored_columns)}")
    for line, reason in report.errors:
        print(f"  [refusee]  ligne {line} — {reason}")

    print(f"\n{report.facts} valeur(s) enregistree(s).")
    db.close()
    return 1 if report.rows_failed and not report.rows_ok else 0


def _cmd_check_business(settings: Settings) -> int:
    """Diagnostic des donnees business."""
    from jarvis_core.diagnostics import check_business, render
    from jarvis_core.runtime import build_runtime

    runtime = build_runtime(settings)
    try:
        print("Etat des donnees business\n")
        return 0 if render(check_business(runtime)) else 1
    finally:
        runtime.db.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis", description="Assistant personnel JARVIS")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("serve", help="lance l'API et l'interface")
    sub.add_parser("chat", help="conversation en mode texte")
    sub.add_parser("doctor", help="verifie la configuration")
    sub.add_parser("sync-env", help="ajoute a .env les nouvelles variables du modele")
    sub.add_parser("check-google", help="teste Gmail, Calendar et Contacts")
    sub.add_parser("check-voice", help="charge le moteur vocal et transcrit un echantillon")
    index = sub.add_parser("index", help="indexe un dossier de documents")
    index.add_argument("path", nargs="?", default="", help="dossier (defaut: JARVIS_DOCUMENTS_DIR)")
    index.add_argument("--force", action="store_true", help="reindexe meme si inchange")
    drive = sub.add_parser("sync-drive", help="indexe le dossier Google Drive configure")
    drive.add_argument("--force", action="store_true", help="reindexe meme si inchange")
    imp = sub.add_parser("import-business", help="importe un CSV de donnees business")
    imp.add_argument("path", help="fichier CSV a importer")
    imp.add_argument("--org", required=True, help="entreprise (id ou nom)")
    imp.add_argument("--replace", action="store_true", help="remplace les imports CSV precedents")
    sub.add_parser("check-documents", help="verifie l'index et le mode de recherche")
    sub.add_parser("check-business", help="etat des donnees business")
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
    if args.command == "check-google":
        return asyncio.run(_cmd_check_google(settings))
    if args.command == "check-voice":
        return asyncio.run(_cmd_check_voice(settings))
    if args.command == "index":
        return _cmd_index(settings, args.path, args.force)
    if args.command == "sync-drive":
        return asyncio.run(_cmd_sync_drive(settings, args.force))
    if args.command == "import-business":
        return _cmd_import_business(settings, args.path, args.org, args.replace)
    if args.command == "check-business":
        return _cmd_check_business(settings)
    if args.command == "check-documents":
        return _cmd_check_documents(settings)
    if args.command == "doctor":
        return _cmd_doctor(settings)
    if args.command == "serve" or args.command is None:
        return _cmd_serve(settings)
    parser.print_help()
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
