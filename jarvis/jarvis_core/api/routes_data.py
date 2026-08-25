"""Donnees agregees pour le centre de commande.

Regle qui gouverne tout ce module: **une carte n'affiche jamais un chiffre
qu'on n'a pas**. Chaque volet porte un statut explicite —

* `connected`     : la source repond, les donnees sont reelles;
* `not_connected` : la source n'est pas branchee, l'interface le dit;
* `error`         : la source a echoue, l'interface le dit aussi.

L'interface s'appuie sur ce statut pour choisir entre une valeur et une
mention « non connecte ». Il n'existe aucun chemin produisant une valeur
fictive.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from jarvis_core.errors import JarvisError
from jarvis_core.runtime import JarvisRuntime
from jarvis_core.timeutils import describe_now, resolve_date_expression

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["data"])

CONNECTED = "connected"
NOT_CONNECTED = "not_connected"
ERROR = "error"

def get_runtime(request: Request) -> JarvisRuntime:
    runtime: JarvisRuntime = request.app.state.runtime
    return runtime


def _pane(status: str, detail: str = "", **payload: Any) -> dict[str, Any]:
    return {"status": status, "detail": detail, **payload}


@router.get("/overview")
async def overview(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Etat du jour, volet par volet, pour l'ecran d'accueil."""
    settings = runtime.settings
    clock = describe_now(settings.timezone)

    return {
        "user": settings.user_name,
        "clock": clock,
        "panes": {
            "today": await _today_pane(runtime),
            "email": await _email_pane(runtime),
            "tasks": _tasks_pane(runtime),
            "business": _business_pane(runtime),
            "memory": _memory_pane(runtime),
            "documents": _documents_pane(runtime),
        },
    }


async def _today_pane(runtime: JarvisRuntime) -> dict[str, Any]:
    """Rendez-vous du jour."""
    if not runtime.settings.feature_calendar:
        return _pane(NOT_CONNECTED, "Google Calendar n'est pas active", events=[])
    if not runtime.google.connected:
        return _pane(NOT_CONNECTED, "Aucun compte Google connecte", events=[])
    try:
        window = resolve_date_expression("aujourd'hui", runtime.settings.timezone)
        events = await runtime.google.calendar.list_events(
            start=window.start.isoformat(), end=window.end.isoformat(), limit=12
        )
    except JarvisError as exc:
        return _pane(ERROR, exc.user_message, events=[])
    except Exception as exc:  # noqa: BLE001 - un volet casse n'abat pas l'ecran
        logger.exception("volet calendrier")
        return _pane(ERROR, repr(exc), events=[])
    return _pane(CONNECTED, "", events=[event.as_dict() for event in events])


async def _email_pane(runtime: JarvisRuntime) -> dict[str, Any]:
    """Courriels non lus recents."""
    if not runtime.settings.feature_gmail:
        return _pane(NOT_CONNECTED, "Gmail n'est pas active", messages=[])
    if not runtime.google.connected:
        return _pane(NOT_CONNECTED, "Aucun compte Google connecte", messages=[])
    try:
        messages = await runtime.google.gmail.search("is:unread in:inbox", limit=8)
    except JarvisError as exc:
        return _pane(ERROR, exc.user_message, messages=[])
    except Exception as exc:  # noqa: BLE001
        logger.exception("volet courriel")
        return _pane(ERROR, repr(exc), messages=[])
    return _pane(CONNECTED, "", messages=[m.as_dict() for m in messages])


def _tasks_pane(runtime: JarvisRuntime) -> dict[str, Any]:
    """Rappels en attente. Toujours disponible: c'est local."""
    reminders = runtime.reminders.list_pending(limit=12)
    return _pane(CONNECTED, "", reminders=[r.as_dict() for r in reminders])


def _business_pane(runtime: JarvisRuntime) -> dict[str, Any]:
    """Etat reel des sources business.

    Ce volet a longtemps repondu « non connecte » en dur, du temps ou aucune
    donnee metier n'existait. Le laisser ainsi apres M4 en ferait un mensonge:
    l'accueil afficherait « aucune source » pendant que la page Entreprises
    montre de vrais chiffres.
    """
    rows = runtime.db.query(
        "SELECT id, name, kind FROM organizations"
        " WHERE id != 'PERSONAL' AND archived = 0 ORDER BY position, name"
    )
    organizations = [
        {"id": str(row["id"]), "name": str(row["name"]), "kind": str(row["kind"])}
        for row in rows
    ]

    store = runtime.business
    if store is None:
        return _pane(
            NOT_CONNECTED,
            "Les donnees business sont desactivees (JARVIS_FEATURE_BUSINESS)",
            organizations=organizations,
            connected_count=0,
        )

    connected = [org for org in organizations if store.latest_day(org["id"])]
    if not connected:
        return _pane(
            NOT_CONNECTED,
            "Aucune donnee importee. Onglet Entreprises pour brancher un CSV",
            organizations=organizations,
            connected_count=0,
        )

    names = ", ".join(org["name"] for org in connected)
    return _pane(
        CONNECTED,
        f"{names} — donnees a jour",
        organizations=organizations,
        connected_count=len(connected),
    )


def _memory_pane(runtime: JarvisRuntime) -> dict[str, Any]:
    if runtime.memory_store is None:
        return _pane(NOT_CONNECTED, "La memoire persistante est desactivee", count=0)
    return _pane(CONNECTED, "", count=runtime.memory_store.count())


def _documents_pane(runtime: JarvisRuntime) -> dict[str, Any]:
    store = runtime.documents
    if store is None:
        return _pane(NOT_CONNECTED, "La recherche documentaire n'est pas activee")
    total = store.count()
    if total == 0:
        return _pane(
            CONNECTED,
            f"Aucun document indexe. Depose des fichiers dans {runtime.settings.documents_dir}",
            count=0,
        )
    return _pane(CONNECTED, "", count=total)


@router.get("/businesses")
async def businesses(
    days: int = 7, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Centre de commande business.

    Chaque indicateur porte son statut ET sa couverture. Un total calcule sur
    4 jours sur 7 est affiche comme tel: sans cette precision, il se lirait
    comme un total de semaine, ce qui serait faux.
    """
    from jarvis_core.business import metrics as vocabulary
    from jarvis_core.business.store import day_range

    rows = runtime.db.query(
        "SELECT id, name, kind FROM organizations"
        " WHERE id != 'PERSONAL' AND archived = 0 ORDER BY position, name"
    )
    store = runtime.business

    if store is None:
        organizations = [
            {
                "id": str(row["id"]),
                "name": str(row["name"]),
                "kind": str(row["kind"]),
                "latest_day": "",
                "metrics": [
                    {
                        "metric": definition.key,
                        "label": definition.label,
                        "unit": definition.unit,
                        "value": None,
                        "display": None,
                        "status": NOT_CONNECTED,
                        "complete": False,
                        "detail": "",
                        "days_requested": 0,
                        "days_covered": 0,
                        "last_day": "",
                        "sources": [],
                    }
                    for definition in vocabulary.for_kind(str(row["kind"]))
                ],
            }
            for row in rows
        ]
        return {
            "enabled": False,
            "organizations": organizations,
            "period": {"days": 0, "start": "", "end": ""},
            "note": (
                "Les donnees business sont desactivees (JARVIS_FEATURE_BUSINESS). "
                "Aucune valeur n'est affichee."
            ),
        }

    today = resolve_date_expression("aujourd'hui", timezone=runtime.settings.timezone).start.date()
    window = max(1, min(days, 365))
    start, end = day_range(window, end=today)

    organizations = []
    for row in rows:
        org_id, kind = str(row["id"]), str(row["kind"])
        readings = [
            store.read(
                org_id=org_id, metric=definition.key, start=start, end=end, today=today
            )
            for definition in vocabulary.for_kind(kind)
        ]
        organizations.append(
            {
                "id": org_id,
                "name": str(row["name"]),
                "kind": kind,
                "latest_day": store.latest_day(org_id),
                "metrics": [reading.as_dict() for reading in readings],
            }
        )

    return {
        "enabled": True,
        "organizations": organizations,
        "period": {"days": window, "start": start.isoformat(), "end": end.isoformat()},
        "imports": store.recent_imports(limit=5),
        "note": "",
    }


@router.post("/businesses/{org_id}/import")
async def import_business_csv(
    org_id: str, request: Request, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Importe un CSV de donnees quotidiennes pour une organisation."""
    from jarvis_core.business.csv_import import ImportError_, import_csv

    store = runtime.business
    if store is None:
        raise HTTPException(status_code=400, detail="Les donnees business sont desactivees.")
    org = runtime.db.query_one(
        "SELECT id, kind FROM organizations WHERE id = ?", (org_id,)
    )
    if org is None:
        raise HTTPException(status_code=404, detail="Entreprise inconnue.")

    form = await request.form()
    upload = form.get("file")
    if upload is None or isinstance(upload, str):
        raise HTTPException(status_code=400, detail="Aucun fichier recu.")

    raw = await upload.read()
    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = raw.decode("cp1252", errors="replace")

    try:
        report = import_csv(
            store,
            content,
            org_id=org_id,
            kind=str(org["kind"]),
            source_ref=upload.filename or "import.csv",
        )
    except ImportError_ as exc:
        raise HTTPException(status_code=400, detail=exc.user_message) from exc
    return {"report": report.as_dict()}


@router.delete("/businesses/{org_id}/data")
async def clear_business_data(
    org_id: str, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Efface les donnees importees d'une organisation."""
    store = runtime.business
    if store is None:
        raise HTTPException(status_code=400, detail="Les donnees business sont desactivees.")
    return {"deleted": store.clear(org_id=org_id)}


@router.get("/memory")
async def list_memory(
    query: str = "",
    kind: str = "",
    limit: int = 100,
    runtime: JarvisRuntime = Depends(get_runtime),
) -> dict[str, Any]:
    """Ce que JARVIS sait, avec la source de chaque souvenir."""
    store = runtime.memory_store
    if store is None:
        return {"enabled": False, "memories": [], "kinds": {}}

    memories = (
        store.search(query, limit=min(limit, 200))
        if query
        else store.recent(limit=min(limit, 200))
    )
    if kind:
        memories = [m for m in memories if m.kind == kind]

    counts: dict[str, int] = {}
    for memory in store.recent(limit=500):
        counts[memory.kind] = counts.get(memory.kind, 0) + 1

    return {
        "enabled": True,
        "memories": [m.as_dict() for m in memories],
        "kinds": counts,
        "total": store.count(),
    }


@router.delete("/memory/{memory_id}")
async def forget_memory(
    memory_id: str, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Suppression definitive d'un souvenir, a la demande explicite."""
    store = runtime.memory_store
    if store is None:
        raise HTTPException(status_code=400, detail="La memoire persistante est desactivee.")
    if not store.forget(memory_id):
        raise HTTPException(status_code=404, detail="Souvenir introuvable.")
    return {"deleted": memory_id}


@router.get("/documents")
async def list_documents(
    query: str = "",
    limit: int = 50,
    runtime: JarvisRuntime = Depends(get_runtime),
) -> dict[str, Any]:
    """Les documents indexes, et — sans mentir — ce que la recherche sait faire.

    `search_modes` dit ce qui tournerait reellement: sans modele semantique
    charge, l'interface annonce « mots exacts » plutot que de laisser croire a
    une comprehension du sens.
    """
    store = runtime.documents
    if store is None:
        return {
            "enabled": False,
            "status": NOT_CONNECTED,
            "detail": "La recherche documentaire est desactivee (JARVIS_FEATURE_DOCUMENTS).",
            "documents": [],
            "total": 0,
            "search_modes": [],
        }

    if query:
        outcome = store.search(query, limit=min(limit, 50))
        return {
            "enabled": True,
            "status": CONNECTED,
            "detail": "",
            "query": query,
            "hits": [hit.as_dict() for hit in outcome.hits],
            "search_modes": list(outcome.modes),
            "total": outcome.indexed_documents,
            "documents": [],
        }

    documents = store.list_documents(limit=min(limit, 200))
    modes = ["lexical"] + (["semantique"] if store.embeddings is not None else [])
    return {
        "enabled": True,
        "status": CONNECTED,
        "detail": "",
        "documents": [doc.as_dict() for doc in documents],
        "total": store.count(),
        "search_modes": modes,
        "documents_dir": runtime.settings.documents_dir,
    }


@router.delete("/documents/{document_id}")
async def forget_document(
    document_id: str, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Retire un document de l'index (le fichier d'origine n'est pas touche)."""
    store = runtime.documents
    if store is None:
        raise HTTPException(status_code=400, detail="La recherche documentaire est desactivee.")
    if not store.delete(document_id):
        raise HTTPException(status_code=404, detail="Document introuvable dans l'index.")
    return {"deleted": document_id}


@router.post("/documents/reindex")
async def reindex_documents(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Relance l'indexation du dossier local configure."""
    from jarvis_core.documents.ingest import ingest_directory
    from jarvis_core.errors import DocumentError

    store = runtime.documents
    if store is None:
        raise HTTPException(status_code=400, detail="La recherche documentaire est desactivee.")
    try:
        report = ingest_directory(store, runtime.settings.documents_dir)
    except DocumentError as exc:
        raise HTTPException(status_code=400, detail=exc.user_message) from exc
    return {"report": report.as_dict(), "summary": report.summary(), "total": store.count()}


# =============================================================================
# Alertes et briefing (M5)
# =============================================================================


@router.get("/alerts")
async def list_alerts(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Alertes actives. Vide veut dire « rien a signaler », pas « pas regarde ».

    La distinction est portee par `enabled`: surveillance eteinte et absence
    d'alerte ne se ressemblent pas.
    """
    return {
        "enabled": runtime.settings.feature_proactive,
        "alerts": runtime.alerts.active(),
        "schedule": runtime.scheduler.status(),
    }


@router.post("/alerts/{alert_id}/seen")
async def mark_alert_seen(
    alert_id: str, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    if not runtime.alerts.mark_seen(alert_id):
        raise HTTPException(status_code=404, detail="Alerte introuvable.")
    return {"seen": alert_id}


@router.delete("/alerts")
async def dismiss_alerts(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    return {"dismissed": runtime.alerts.dismiss_all()}


@router.post("/alerts/check")
async def check_alerts_now(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Force un passage de surveillance, sans attendre la prochaine echeance."""
    from jarvis_core.proactive import collect_alerts

    if not runtime.settings.feature_proactive:
        raise HTTPException(status_code=400, detail="La surveillance proactive est desactivee.")
    runtime.alerts.purge_expired()
    fresh = runtime.alerts.record(await collect_alerts(runtime))
    return {"new": fresh, "alerts": runtime.alerts.active()}


@router.get("/briefing")
async def read_briefing(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Dernier briefing genere, s'il y en a un."""
    latest = runtime.briefings.latest()
    return {
        "briefing": latest,
        "scheduled_at": runtime.settings.briefing_time,
    }


@router.post("/briefing")
async def make_briefing(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Genere le briefing maintenant."""
    from jarvis_core.briefing import generate_briefing

    try:
        return {"briefing": await generate_briefing(runtime)}
    except JarvisError as exc:
        raise HTTPException(status_code=400, detail=exc.user_message) from exc


# --- gestion des organisations ------------------------------------------------
# Les entreprises appartiennent a l'utilisateur, pas au code. Les valeurs de
# depart ne sont que des valeurs de depart.


class OrganizationInput(BaseModel):
    """Creation ou modification d'une entreprise."""

    name: str = Field(min_length=1, max_length=80)
    kind: str = Field(default="restaurant")


#: Types connus: chacun determine les indicateurs proposes.
ORG_KINDS = ("restaurant", "saas", "realestate", "other")


def _slug(name: str) -> str:
    """Identifiant stable derive du nom, sans accents ni espaces."""
    folded = unicodedata.normalize("NFKD", name)
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", folded).strip("_").upper()
    return cleaned[:40] or "ORG"


@router.post("/businesses", status_code=201)
async def create_organization(
    payload: OrganizationInput, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Ajoute une entreprise."""
    if payload.kind not in ORG_KINDS:
        raise HTTPException(
            status_code=400, detail=f"Type inconnu. Choix: {', '.join(ORG_KINDS)}"
        )

    base = _slug(payload.name)
    org_id = base
    # Deux entreprises peuvent porter des noms proches: on suffixe plutot que
    # d'ecraser silencieusement l'existante.
    suffix = 2
    while runtime.db.query_one("SELECT id FROM organizations WHERE id = ?", (org_id,)):
        org_id = f"{base}_{suffix}"
        suffix += 1

    row = runtime.db.query_one("SELECT MAX(position) AS p FROM organizations")
    position = int(row["p"] or 0) + 10 if row else 100
    runtime.db.execute(
        "INSERT INTO organizations (id, name, kind, created_at, position, archived)"
        " VALUES (?,?,?,?,?,0)",
        (
            org_id,
            payload.name.strip(),
            payload.kind,
            datetime.now(UTC).isoformat(),
            position,
        ),
    )
    return {"id": org_id, "name": payload.name.strip(), "kind": payload.kind}


@router.patch("/businesses/{org_id}")
async def rename_organization(
    org_id: str, payload: OrganizationInput, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Renomme une entreprise ou change son type."""
    if not runtime.db.query_one("SELECT id FROM organizations WHERE id = ?", (org_id,)):
        raise HTTPException(status_code=404, detail="Entreprise inconnue.")
    if payload.kind not in ORG_KINDS:
        raise HTTPException(status_code=400, detail="Type inconnu.")
    runtime.db.execute(
        "UPDATE organizations SET name = ?, kind = ? WHERE id = ?",
        (payload.name.strip(), payload.kind, org_id),
    )
    return {"id": org_id, "name": payload.name.strip(), "kind": payload.kind}


@router.delete("/businesses/{org_id}")
async def archive_organization(
    org_id: str, purge: bool = False, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Retire une entreprise de la liste.

    Par defaut elle est **archivee**, pas detruite: ses chiffres restent en
    base et reapparaissent si elle est restauree. `purge=true` supprime pour de
    bon — c'est irreversible, donc jamais le comportement par defaut.
    """
    if org_id == "PERSONAL":
        raise HTTPException(status_code=400, detail="Le contexte personnel ne se retire pas.")
    if not runtime.db.query_one("SELECT id FROM organizations WHERE id = ?", (org_id,)):
        raise HTTPException(status_code=404, detail="Entreprise inconnue.")

    if purge:
        runtime.db.execute("DELETE FROM business_facts WHERE org_id = ?", (org_id,))
        runtime.db.execute("DELETE FROM business_imports WHERE org_id = ?", (org_id,))
        runtime.db.execute("DELETE FROM organizations WHERE id = ?", (org_id,))
        return {"purged": org_id}

    runtime.db.execute("UPDATE organizations SET archived = 1 WHERE id = ?", (org_id,))
    return {"archived": org_id}


@router.post("/businesses/{org_id}/restore")
async def restore_organization(
    org_id: str, runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    if not runtime.db.query_one("SELECT id FROM organizations WHERE id = ?", (org_id,)):
        raise HTTPException(status_code=404, detail="Entreprise inconnue.")
    runtime.db.execute("UPDATE organizations SET archived = 0 WHERE id = ?", (org_id,))
    return {"restored": org_id}
