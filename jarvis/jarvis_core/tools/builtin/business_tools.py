"""Outils de consultation des donnees business.

Ces outils portent le risque le plus direct du projet: un chiffre invente sur
un restaurant, et Greg prend une decision sur du vide.

Trois protections, toutes dans le texte renvoye au modele.

1. **Une valeur absente n'est jamais un zero.**  L'outil dit « aucune donnee »,
   ce qui se distingue d'une vraie journee a zero vente.
2. **La couverture accompagne le chiffre.**  « 27 731 $ sur les 4 jours dont
   j'ai les donnees » et « 27 731 $ cette semaine » ne sont pas la meme
   affirmation.
3. **La fraicheur est dite.**  Une donnee vieille de trois semaines est
   annoncee comme telle.

La liste des indicateurs est fermee: le modele ne peut pas demander « la marge
nette », qui n'existe pas, et recevoir un silence interpretable comme un zero.
"""

from __future__ import annotations

from datetime import timedelta

from jarvis_core.business import metrics as vocabulary
from jarvis_core.business.store import CONNECTED, NOT_CONNECTED, STALE, MetricReading, day_range
from jarvis_core.security.permissions import PermissionLevel
from jarvis_core.timeutils import now as now_in
from jarvis_core.tools.base import Citation, ToolContext, ToolResult
from jarvis_core.tools.registry import registry

#: Periodes que le modele peut demander, traduites en nombre de jours.
PERIODS: dict[str, int] = {
    "aujourdhui": 1,
    "hier": 1,
    "7jours": 7,
    "30jours": 30,
    "90jours": 90,
}


def _not_configured() -> ToolResult:
    return ToolResult.failure(
        summary=(
            "Aucune source de donnees business n'est branchee. "
            "Je n'ai aucun chiffre de vente, de couverts ou de masse salariale — "
            "je ne peux donc rien avancer la-dessus."
        ),
        data={"status": NOT_CONNECTED},
    )


def _resolve_org(ctx: ToolContext, organization: str) -> tuple[str, str, str]:
    """Retrouve (id, nom, type) a partir d'un nom approximatif."""
    store = ctx.business
    if store is None:
        return "", "", ""
    needle = organization.strip().lower()
    found = store.db.query("SELECT id, name, kind FROM organizations"
        " WHERE id != 'PERSONAL' AND archived = 0 ORDER BY position, name")
    for row in found:
        if needle in (str(row["id"]).lower(), str(row["name"]).lower()):
            return str(row["id"]), str(row["name"]), str(row["kind"])
    for row in found:
        if needle and needle in str(row["name"]).lower():
            return str(row["id"]), str(row["name"]), str(row["kind"])
    return "", "", ""


def _describe(reading: MetricReading) -> str:
    """Une ligne honnete pour un indicateur."""
    if reading.status == NOT_CONNECTED or reading.value is None:
        return f"- {reading.label}: aucune donnee ({reading.detail})"
    line = f"- {reading.label}: {reading.formatted()}"
    if reading.status == STALE:
        return f"{line} — ATTENTION, {reading.detail.lower()}"
    if not reading.complete:
        return f"{line} (seulement {reading.days_covered} jour(s) sur {reading.days_requested})"
    return line


@registry.tool(
    name="get_business_metrics",
    description=(
        "Chiffres d'une entreprise (ventes, couverts, masse salariale, revenus recurrents, "
        "occupation) sur une periode. "
        "Rapporte les valeurs telles quelles: si un indicateur n'a pas de donnee, dis-le, "
        "n'avance jamais un chiffre. Si la couverture est partielle, precise sur combien de "
        "jours porte le total avant de donner le chiffre."
    ),
    permission=PermissionLevel.READ,
    feature_flag="business",
    schema={
        "type": "object",
        "properties": {
            "organization": {
                "type": "string",
                "description": "Nom de l'entreprise (ex: Grande Allee, Maguire, Portail).",
                "maxLength": 80,
            },
            "period": {
                "type": "string",
                "enum": sorted(PERIODS),
                "description": "Periode couverte (defaut 7jours).",
            },
        },
        "required": ["organization"],
    },
    tags=("business",),
)
async def get_business_metrics(
    ctx: ToolContext, *, organization: str, period: str = "7jours"
) -> ToolResult:
    store = ctx.business
    if store is None:
        return _not_configured()

    org_id, name, kind = _resolve_org(ctx, organization)
    if not org_id:
        known = store.db.query(
            "SELECT name FROM organizations WHERE id != 'PERSONAL' ORDER BY name"
        )
        names = ", ".join(str(row["name"]) for row in known)
        return ToolResult.failure(
            summary=(
                f"Je ne connais pas d'entreprise nommee « {organization} ». "
                f"Celles que je connais: {names}."
            ),
            data={"status": "unknown_organization"},
        )

    today = now_in(ctx.timezone).date()
    days = PERIODS.get(period, 7)
    if period == "hier":
        end = today - timedelta(days=1)
        start = end
    elif period == "aujourdhui":
        start = end = today
    else:
        start, end = day_range(days, end=today)

    definitions = vocabulary.for_kind(kind)
    if not definitions:
        return ToolResult.failure(
            summary=f"Je n'ai pas d'indicateurs definis pour « {name} » (type {kind}).",
            data={"status": "unsupported_kind"},
        )

    readings = [
        store.read(org_id=org_id, metric=definition.key, start=start, end=end, today=today)
        for definition in definitions
    ]
    available = [r for r in readings if r.value is not None]

    if not available:
        return ToolResult.success(
            summary=(
                f"Aucune donnee pour {name} sur cette periode "
                f"({start.isoformat()} au {end.isoformat()}). "
                "Aucun systeme de caisse ou de facturation n'alimente encore ces "
                "indicateurs — je ne peux rien affirmer sur les chiffres de cette entreprise."
            ),
            data={
                "status": NOT_CONNECTED,
                "organization": name,
                "metrics": [r.as_dict() for r in readings],
            },
        )

    lines = [
        f"{name} — {start.isoformat()} au {end.isoformat()} "
        f"({(end - start).days + 1} jour(s) demandes) :"
    ]
    lines.extend(_describe(reading) for reading in readings)

    ratio = vocabulary.derived_labour_ratio(
        next((r.value for r in readings if r.metric == "sales"), None),
        next((r.value for r in readings if r.metric == "labour_cost"), None),
    )
    if ratio is not None:
        lines.append(f"- Masse salariale en % des ventes: {ratio} %")

    sources = sorted({s for r in available for s in r.sources})
    lines.append(f"\nSource(s): {', '.join(sources)}.")

    return ToolResult.success(
        summary="\n".join(lines),
        data={
            "status": CONNECTED,
            "organization": name,
            "org_id": org_id,
            "start": start.isoformat(),
            "end": end.isoformat(),
            "metrics": [r.as_dict() for r in readings],
            "labour_ratio": ratio,
        },
        citations=[
            Citation(label=f"{name} — donnees {', '.join(sources)}", kind="business")
        ],
        display="table",
    )


@registry.tool(
    name="compare_business_periods",
    description=(
        "Compare un indicateur entre deux periodes consecutives (ex: cette semaine contre "
        "la precedente). "
        "Si l'une des deux periodes n'a pas de donnees completes, dis-le avant de commenter "
        "l'ecart: comparer 4 jours a 7 jours n'a aucun sens."
    ),
    permission=PermissionLevel.READ,
    feature_flag="business",
    schema={
        "type": "object",
        "properties": {
            "organization": {"type": "string", "maxLength": 80},
            "metric": {
                "type": "string",
                "enum": sorted(vocabulary.METRICS),
                "description": "Indicateur a comparer.",
            },
            "days": {
                "type": "integer",
                "minimum": 1,
                "maximum": 90,
                "description": "Longueur de chaque periode en jours (defaut 7).",
            },
        },
        "required": ["organization", "metric"],
    },
    tags=("business",),
)
async def compare_business_periods(
    ctx: ToolContext, *, organization: str, metric: str, days: int = 7
) -> ToolResult:
    store = ctx.business
    if store is None:
        return _not_configured()

    org_id, name, _ = _resolve_org(ctx, organization)
    if not org_id:
        return ToolResult.failure(
            summary=f"Je ne connais pas d'entreprise nommee « {organization} ».",
            data={"status": "unknown_organization"},
        )

    definition = vocabulary.get(metric)
    if definition is None:
        return ToolResult.failure(
            summary=f"Indicateur inconnu: {metric}.",
            data={"status": "unknown_metric"},
        )

    today = now_in(ctx.timezone).date()
    current_start, current_end = day_range(days, end=today)
    previous_end = current_start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=days - 1)

    current = store.read(
        org_id=org_id, metric=metric, start=current_start, end=current_end, today=today
    )
    previous = store.read(
        org_id=org_id, metric=metric, start=previous_start, end=previous_end, today=today
    )

    if current.value is None or previous.value is None:
        missing = "la periode actuelle" if current.value is None else "la periode precedente"
        return ToolResult.success(
            summary=(
                f"Je ne peux pas comparer: aucune donnee de {definition.label.lower()} "
                f"pour {missing} chez {name}. Comparer avec une periode vide donnerait "
                "un ecart trompeur."
            ),
            data={
                "status": NOT_CONNECTED,
                "current": current.as_dict(),
                "previous": previous.as_dict(),
            },
        )

    delta = current.value - previous.value
    percent = (delta / previous.value * 100) if previous.value else None

    lines = [
        f"{name} — {definition.label}",
        f"- {current_start.isoformat()} au {current_end.isoformat()}: "
        f"{definition.format(current.value)}"
        + ("" if current.complete else f" ({current.days_covered}/{current.days_requested} jours)"),
        f"- {previous_start.isoformat()} au {previous_end.isoformat()}: "
        f"{definition.format(previous.value)}"
        + (
            ""
            if previous.complete
            else f" ({previous.days_covered}/{previous.days_requested} jours)"
        ),
    ]
    if percent is not None:
        lines.append(f"- Ecart: {delta:+,.2f} ({percent:+.1f} %)".replace(",", " "))
    else:
        lines.append(f"- Ecart: {delta:+,.2f}".replace(",", " "))

    if not (current.complete and previous.complete):
        lines.append(
            "\nATTENTION: les deux periodes n'ont pas la meme couverture. "
            "L'ecart n'est pas directement comparable."
        )

    return ToolResult.success(
        summary="\n".join(lines),
        data={
            "status": CONNECTED,
            "organization": name,
            "metric": metric,
            "current": current.as_dict(),
            "previous": previous.as_dict(),
            "delta": round(delta, 2),
            "percent": round(percent, 1) if percent is not None else None,
            "comparable": current.complete and previous.complete,
        },
        display="table",
    )


@registry.tool(
    name="list_business_sources",
    description=(
        "Liste les entreprises connues et, pour chacune, quels indicateurs ont "
        "reellement des donnees. Utilise cet outil pour repondre a « qu'est-ce que tu "
        "sais de mes affaires ? » avant d'avancer quoi que ce soit."
    ),
    permission=PermissionLevel.READ,
    feature_flag="business",
    schema={"type": "object", "properties": {}},
    tags=("business",),
)
async def list_business_sources(ctx: ToolContext) -> ToolResult:
    store = ctx.business
    if store is None:
        return _not_configured()

    rows = store.db.query(
        "SELECT id, name, kind FROM organizations"
        " WHERE id != 'PERSONAL' AND archived = 0 ORDER BY position, name"
    )
    lines: list[str] = []
    payload: list[dict[str, object]] = []
    for row in rows:
        org_id, name, kind = str(row["id"]), str(row["name"]), str(row["kind"])
        connected = store.connected_metrics(org_id)
        expected = [d.key for d in vocabulary.for_kind(kind)]
        labels = [
            vocabulary.METRICS[key].label for key in expected if key in connected
        ]
        latest = store.latest_day(org_id)
        if labels:
            lines.append(
                f"- {name}: {', '.join(labels)} (derniere donnee: {latest or 'inconnue'})"
            )
        else:
            lines.append(f"- {name}: aucune donnee branchee")
        payload.append(
            {
                "id": org_id,
                "name": name,
                "kind": kind,
                "connected_metrics": sorted(connected),
                "latest_day": latest,
            }
        )

    header = (
        "Etat des donnees business (ce dont je dispose reellement) :"
        if payload
        else "Aucune entreprise n'est declaree."
    )
    return ToolResult.success(
        summary="\n".join([header, *lines]),
        data={"organizations": payload},
        display="list",
    )
