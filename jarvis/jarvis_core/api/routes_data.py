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
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from jarvis_core.errors import JarvisError
from jarvis_core.runtime import JarvisRuntime
from jarvis_core.timeutils import describe_now, resolve_date_expression

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["data"])

CONNECTED = "connected"
NOT_CONNECTED = "not_connected"
ERROR = "error"

#: Indicateurs attendus par type d'organisation. Ils structurent la page
#: Business tant qu'aucune source n'est branchee.
BUSINESS_METRICS: dict[str, list[str]] = {
    "restaurant": ["Ventes du jour", "Masse salariale", "Reservations", "Alertes"],
    "saas": ["Revenus recurrents", "Portes", "Clients", "Pipeline"],
    "realestate": ["Immeubles", "Occupation", "Loyers percus", "Alertes"],
    "personal": [],
}


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
    """Organisations declarees. Aucune donnee metier n'est encore branchee."""
    rows = runtime.db.query(
        "SELECT id, name, kind FROM organizations WHERE id != 'PERSONAL' ORDER BY name"
    )
    return _pane(
        NOT_CONNECTED,
        "Aucune source de donnees business n'est branchee",
        organizations=[
            {"id": row["id"], "name": row["name"], "kind": row["kind"]} for row in rows
        ],
    )


def _memory_pane(runtime: JarvisRuntime) -> dict[str, Any]:
    if runtime.memory_store is None:
        return _pane(NOT_CONNECTED, "La memoire persistante est desactivee", count=0)
    return _pane(CONNECTED, "", count=runtime.memory_store.count())


@router.get("/businesses")
async def businesses(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Centre de commande business.

    Chaque indicateur porte son statut. Tant qu'aucun systeme de caisse ou de
    facturation n'est branche, ils valent tous `not_connected` — jamais un
    chiffre plausible mais faux.
    """
    rows = runtime.db.query(
        "SELECT id, name, kind FROM organizations WHERE id != 'PERSONAL' ORDER BY name"
    )
    organizations = []
    for row in rows:
        metrics = BUSINESS_METRICS.get(row["kind"], [])
        organizations.append(
            {
                "id": row["id"],
                "name": row["name"],
                "kind": row["kind"],
                "metrics": [
                    {"label": label, "status": NOT_CONNECTED, "value": None}
                    for label in metrics
                ],
            }
        )
    return {
        "organizations": organizations,
        "note": (
            "Les integrations business arrivent en M4 (caisses, Stripe, 7Shifts). "
            "Aucune valeur n'est affichee tant qu'une source reelle n'est pas branchee."
        ),
    }


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
