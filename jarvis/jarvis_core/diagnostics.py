"""Diagnostic des integrations.

Quand quelque chose ne marche pas, la question est toujours la meme: est-ce le
modele qui n'appelle pas l'outil, ou l'integration qui echoue? Ce module
court-circuite le modele et appelle les API directement, pour repondre sans
ambiguite.

Chaque verification retourne un statut et une consigne. Aucune ne masque une
erreur: c'est tout l'interet.
"""

from __future__ import annotations

import traceback
from dataclasses import dataclass, field
from typing import Any

from jarvis_core.errors import JarvisError
from jarvis_core.timeutils import resolve_date_expression

OK, WARN, FAIL = "ok", "warn", "fail"


@dataclass
class CheckResult:
    """Resultat d'une verification, lisible tel quel."""

    name: str
    status: str
    detail: str
    hint: str = ""
    data: dict[str, Any] = field(default_factory=dict)


async def check_google(runtime: Any) -> list[CheckResult]:
    """Teste la chaine Google de bout en bout, etape par etape."""
    google = runtime.google
    results: list[CheckResult] = []

    # 1. Identifiants OAuth presents ?
    if not google.configured:
        return [
            CheckResult(
                "Identifiants OAuth",
                FAIL,
                "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET absents de .env",
                "Lance 'jarvis sync-env', puis suis docs/google-setup.md",
            )
        ]
    results.append(CheckResult("Identifiants OAuth", OK, "renseignes"))

    # 2. Un compte a-t-il accorde l'acces ?
    status = google.status()
    if not status.get("connected"):
        results.append(
            CheckResult(
                "Compte connecte",
                FAIL,
                "aucun compte Google relie",
                "Interface > Integrations > Connecter Google",
            )
        )
        return results
    account = status.get("account") or "(adresse inconnue)"
    results.append(CheckResult("Compte connecte", OK, account))

    # 3. Les feature flags exposent-ils les outils ?
    features = runtime.settings.feature_map()
    if not features.get("gmail") and not features.get("calendar"):
        results.append(
            CheckResult(
                "Feature flags",
                FAIL,
                "gmail et calendar sont tous deux desactives",
                "Mets JARVIS_FEATURE_GMAIL=true et JARVIS_FEATURE_CALENDAR=true dans .env",
            )
        )
        return results
    active = [name for name in ("gmail", "calendar") if features.get(name)]
    results.append(CheckResult("Feature flags", OK, ", ".join(active)))

    # 4. Les portees accordees couvrent-elles ce qui est active ?
    granted = set(status.get("scopes") or [])
    required = {
        "gmail": ("https://www.googleapis.com/auth/gmail.readonly", "lire les courriels"),
        "calendar": ("https://www.googleapis.com/auth/calendar.events", "lire l'agenda"),
    }
    for flag, (scope, label) in required.items():
        if features.get(flag) and scope not in granted:
            results.append(
                CheckResult(
                    f"Permission — {label}",
                    FAIL,
                    "non accordee par Google",
                    "Deconnecte puis reconnecte le compte pour redemander cette permission",
                )
            )
    if all(r.status == OK for r in results):
        results.append(
            CheckResult("Permissions", OK, f"{len(granted)} portees accordees")
        )

    # 5. Appels reels.
    if features.get("calendar"):
        results.append(await _check_calendar(runtime, google))
    if features.get("gmail"):
        results.append(await _check_gmail(google))
        results.append(await _check_contacts(google))

    return results


async def _check_calendar(runtime: Any, google: Any) -> CheckResult:
    window = resolve_date_expression("demain", runtime.settings.timezone)
    try:
        events = await google.calendar.list_events(
            start=window.start.isoformat(), end=window.end.isoformat(), limit=5
        )
    except JarvisError as exc:
        return CheckResult(
            "Calendar", FAIL, exc.user_message, str(exc.detail or "")[:200]
        )
    except Exception as exc:  # noqa: BLE001 - le diagnostic doit tout capturer
        return CheckResult("Calendar", FAIL, repr(exc), traceback.format_exc(limit=2))
    return CheckResult(
        "Calendar",
        OK,
        f"{len(events)} evenement(s) demain",
        data={"events": [e.title for e in events]},
    )


async def _check_gmail(google: Any) -> CheckResult:
    try:
        messages = await google.gmail.search("in:inbox", limit=3)
    except JarvisError as exc:
        return CheckResult("Gmail", FAIL, exc.user_message, str(exc.detail or "")[:200])
    except Exception as exc:  # noqa: BLE001
        return CheckResult("Gmail", FAIL, repr(exc), traceback.format_exc(limit=2))
    return CheckResult(
        "Gmail",
        OK,
        f"{len(messages)} message(s) lus dans la boite de reception",
        data={"sujets": [m.subject for m in messages]},
    )


async def _check_contacts(google: Any) -> CheckResult:
    try:
        contacts = await google.contacts.search("a", limit=3)
    except JarvisError as exc:
        return CheckResult(
            "Contacts",
            WARN,
            exc.user_message,
            "People API activee dans Google Cloud ? Le reste fonctionne sans.",
        )
    except Exception as exc:  # noqa: BLE001
        return CheckResult(
            "Contacts", WARN, repr(exc), "Sans contacts, les prenoms ne seront pas resolus."
        )
    return CheckResult("Contacts", OK, f"{len(contacts)} contact(s) trouve(s)")


def render(results: list[CheckResult]) -> bool:
    """Affiche les resultats; retourne vrai si une verification a echoue."""
    marks = {OK: " ok  ", WARN: "warn ", FAIL: "ECHEC"}
    failed = False
    for result in results:
        if result.status == FAIL:
            failed = True
        print(f"  [{marks[result.status]}] {result.name:28} {result.detail}")
        if result.hint:
            print(f"           -> {result.hint}")
        for key, value in result.data.items():
            if value:
                print(f"           {key}: {value}")
    return failed
