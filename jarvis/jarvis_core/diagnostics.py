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
from datetime import date
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


def _silent_wav(seconds: float = 1.0, rate: int = 16000) -> bytes:
    """Genere un WAV mono valide, sans dependance externe.

    Il sert a valider la chaine complete — decodage, chargement du modele,
    inference — sans micro et sans fichier a fournir. Whisper renverra un
    texte vide sur du silence: c'est attendu, ce qu'on teste ici c'est que
    rien ne casse en chemin.
    """
    import io
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * int(rate * seconds))
    return buffer.getvalue()


async def check_voice(runtime: Any) -> list[CheckResult]:
    """Teste le pipeline vocal cote serveur, sans micro.

    Le micro et la lecture audio vivent dans le navigateur: ils ne peuvent pas
    etre testes ici, et c'est dit explicitement plutot que passe sous silence.
    """
    settings = runtime.settings
    results: list[CheckResult] = []

    # 1. Un moteur de transcription est-il declare ?
    if settings.stt_provider == "null":
        results.append(
            CheckResult(
                "Moteur de transcription",
                FAIL,
                "JARVIS_STT_PROVIDER=null — aucun moteur",
                "Mets JARVIS_STT_PROVIDER=faster_whisper dans .env, "
                "puis: pip install faster-whisper",
            )
        )
        return results
    results.append(
        CheckResult("Moteur de transcription", OK, settings.stt_provider)
    )

    # 2. La librairie est-elle installee ?
    if settings.stt_provider == "faster_whisper":
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            results.append(
                CheckResult(
                    "Librairie faster-whisper",
                    FAIL,
                    "non installee",
                    "Lance: .\\.venv\\Scripts\\python.exe -m pip install faster-whisper",
                )
            )
            return results
        results.append(
            CheckResult(
                "Librairie faster-whisper", OK, f"modele « {settings.stt_local_model} »"
            )
        )
    elif settings.stt_provider == "openai" and not settings.openai_api_key:
        results.append(
            CheckResult(
                "Cle OpenAI",
                FAIL,
                "OPENAI_API_KEY absente",
                "Renseigne-la dans .env, ou passe a faster_whisper (local, gratuit)",
            )
        )
        return results

    # 3. Transcription reelle d'un echantillon genere.
    if settings.stt_provider == "faster_whisper":
        from jarvis_core.voice.stt.local_whisper import MODEL_SIZES_MB

        weight = MODEL_SIZES_MB.get(settings.stt_local_model)
        detail = f" (~{weight} Mo)" if weight else ""
        print(
            f"  … chargement du modele « {settings.stt_local_model} »{detail}. "
            "Au premier lancement il est telecharge: patiente, c'est normal."
        )
    else:
        print("  … appel du service de transcription")
    import time

    started = time.perf_counter()
    try:
        transcript = await runtime.stt.transcribe(
            _silent_wav(), mime="audio/wav", language=settings.default_language
        )
    except JarvisError as exc:
        results.append(
            CheckResult(
                "Transcription", FAIL, exc.user_message, str(exc.detail or "")[:200]
            )
        )
        return results
    except Exception as exc:  # noqa: BLE001 - le diagnostic capture tout
        results.append(
            CheckResult("Transcription", FAIL, repr(exc), traceback.format_exc(limit=2))
        )
        return results

    elapsed = int((time.perf_counter() - started) * 1000)
    results.append(
        CheckResult(
            "Transcription",
            OK,
            f"moteur charge et fonctionnel ({elapsed} ms sur un echantillon muet)",
            "" if elapsed < 20000 else "Premier appel: le modele vient d'etre telecharge.",
            data={"texte rendu": repr(transcript.text) + " (vide = normal sur du silence)"},
        )
    )

    # 4. Synthese vocale.
    if settings.tts_provider == "null":
        results.append(
            CheckResult(
                "Voix",
                OK,
                "voix du systeme (navigateur)",
                "Pour une voix plus naturelle: JARVIS_TTS_PROVIDER=elevenlabs",
            )
        )
    else:
        try:
            audio = await runtime.tts.synthesize("Test.")
        except JarvisError as exc:
            results.append(CheckResult("Voix", FAIL, exc.user_message))
        else:
            size = len(audio.data) if audio else 0
            results.append(
                CheckResult("Voix", OK, f"{settings.tts_provider} — {size} octets generes")
            )

    results.append(
        CheckResult(
            "Micro et lecture audio",
            WARN,
            "non testables ici: ils vivent dans le navigateur",
            "Le micro exige localhost ou HTTPS, et une autorisation du navigateur.",
        )
    )
    return results


def check_documents(runtime: Any) -> list[CheckResult]:
    """Verifie l'index documentaire et dit franchement ce que la recherche sait faire.

    Le point important est le dernier controle: une recherche lexicale et une
    recherche semantique ne repondent pas aux memes questions. Annoncer la
    seconde quand seule la premiere tourne rendrait tout « je n'ai rien
    trouve » trompeur.
    """
    results: list[CheckResult] = []
    settings = runtime.settings

    if not settings.feature_documents:
        return [
            CheckResult(
                name="Documents",
                status=WARN,
                detail="desactives",
                hint="Mets JARVIS_FEATURE_DOCUMENTS=true dans .env pour les activer.",
            )
        ]

    store = runtime.documents
    if store is None:  # pragma: no cover - incoherence de configuration
        return [
            CheckResult(
                name="Documents",
                status=FAIL,
                detail="magasin non initialise",
                hint="Signale ce cas: le flag est actif mais le magasin est absent.",
            )
        ]

    # 1. Le dossier surveille existe-t-il ?
    from pathlib import Path

    folder = Path(settings.documents_dir).expanduser()
    if folder.is_dir():
        candidates = [p for p in folder.rglob("*") if p.is_file() and not p.name.startswith(".")]
        results.append(
            CheckResult(
                name="Dossier surveille",
                status=OK,
                detail=f"{folder} ({len(candidates)} fichier(s))",
            )
        )
    else:
        results.append(
            CheckResult(
                name="Dossier surveille",
                status=FAIL,
                detail=f"{folder} n'existe pas",
                hint="Cree le dossier, ou corrige JARVIS_DOCUMENTS_DIR dans .env.",
            )
        )

    # 2. Y a-t-il quelque chose dans l'index ?
    total = store.count()
    results.append(
        CheckResult(
            name="Index",
            status=OK if total else WARN,
            detail=f"{total} document(s) indexe(s)",
            hint="" if total else "Lance: jarvis index",
        )
    )

    # 3. Quelle recherche tournera reellement ?
    if not settings.embedding_enabled:
        results.append(
            CheckResult(
                name="Recherche",
                status=OK,
                detail="lexicale (mots exacts), semantique desactivee",
                hint="JARVIS_EMBEDDING_ENABLED=true pour activer la recherche par le sens.",
            )
        )
    else:
        provider = store.embeddings
        if provider is None:
            results.append(
                CheckResult(
                    name="Recherche",
                    status=WARN,
                    detail="lexicale seulement — le modele semantique n'a pas pu etre charge",
                    hint=(
                        "Verifie la connexion Internet: le modele se telecharge une "
                        "seule fois (~220 Mo). La recherche par mots exacts fonctionne "
                        "en attendant."
                    ),
                )
            )
        else:
            results.append(
                CheckResult(
                    name="Recherche",
                    status=OK,
                    detail=f"lexicale + semantique ({provider.name})",
                )
            )

    # 4. L'index repond-il vraiment ?
    if total:
        try:
            outcome = store.search("contrat", limit=1)
            results.append(
                CheckResult(
                    name="Requete test",
                    status=OK,
                    detail=f"modes actifs: {', '.join(outcome.modes)}",
                )
            )
        except Exception as exc:  # noqa: BLE001 - on veut la cause exacte a l'ecran
            results.append(
                CheckResult(
                    name="Requete test",
                    status=FAIL,
                    detail=str(exc)[:160],
                    hint="Reindexe: jarvis index --force",
                )
            )
    return results


def check_business(runtime: Any) -> list[CheckResult]:
    """Etat des donnees business, organisation par organisation.

    Repond a la seule question qui compte avant de faire confiance a un
    chiffre: d'ou vient-il, et de quand date-t-il.
    """
    from jarvis_core.business import metrics as vocabulary

    settings = runtime.settings
    if not settings.feature_business:
        return [
            CheckResult(
                name="Donnees business",
                status=WARN,
                detail="desactivees",
                hint="Mets JARVIS_FEATURE_BUSINESS=true dans .env pour les activer.",
            )
        ]

    store = runtime.business
    if store is None:  # pragma: no cover - incoherence de configuration
        return [
            CheckResult(
                name="Donnees business",
                status=FAIL,
                detail="magasin non initialise",
                hint="Signale ce cas: le flag est actif mais le magasin est absent.",
            )
        ]

    results: list[CheckResult] = []
    rows = runtime.db.query(
        "SELECT id, name, kind FROM organizations"
        " WHERE id != 'PERSONAL' AND archived = 0 ORDER BY position, name"
    )
    if not rows:
        return [
            CheckResult(
                name="Donnees business",
                status=FAIL,
                detail="aucune organisation declaree",
                hint="La migration 0003 devrait les creer. Relance jarvis serve.",
            )
        ]

    today = resolve_date_expression("aujourd'hui", timezone=settings.timezone).start.date()
    for row in rows:
        org_id, name, kind = str(row["id"]), str(row["name"]), str(row["kind"])
        connected = store.connected_metrics(org_id)
        expected = [d.key for d in vocabulary.for_kind(kind)]
        present = [k for k in expected if k in connected]

        if not present:
            results.append(
                CheckResult(
                    name=name,
                    status=WARN,
                    detail="aucune donnee",
                    hint=f"Importe un CSV: jarvis import-business <fichier> --org {org_id}",
                )
            )
            continue

        latest = store.latest_day(org_id)
        age = (today - date.fromisoformat(latest)).days if latest else 999
        labels = ", ".join(vocabulary.METRICS[k].label for k in present)
        missing = [vocabulary.METRICS[k].label for k in expected if k not in connected]

        if age > 7:
            results.append(
                CheckResult(
                    name=name,
                    status=WARN,
                    detail=f"{labels} — derniere donnee il y a {age} jours ({latest})",
                    hint="Reimporte un export recent pour que les chiffres restent utiles.",
                )
            )
        else:
            detail = f"{labels} — a jour ({latest})"
            results.append(
                CheckResult(
                    name=name,
                    status=OK,
                    detail=detail,
                    hint=f"Sans donnee: {', '.join(missing)}" if missing else "",
                )
            )
    return results


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
