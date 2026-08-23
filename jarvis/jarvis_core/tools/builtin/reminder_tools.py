"""Outils de rappels."""

from __future__ import annotations

from jarvis_core.memory.session import ReferencedItem
from jarvis_core.security.permissions import PermissionLevel
from jarvis_core.timeutils import format_datetime_fr, resolve_date_expression
from jarvis_core.tools.base import ToolContext, ToolResult
from jarvis_core.tools.registry import registry


@registry.tool(
    name="create_reminder",
    description=(
        "Cree un rappel. Le champ 'when' accepte une expression naturelle "
        "('demain matin', 'vendredi prochain', 'dans 2 heures') ou une date ISO."
    ),
    permission=PermissionLevel.LOW_WRITE,
    schema={
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "Ce dont il faut se souvenir.",
                "maxLength": 500,
            },
            "when": {
                "type": "string",
                "description": "Quand rappeler. Ex: 'demain matin', '2026-09-01'.",
                "maxLength": 100,
            },
        },
        "required": ["text", "when"],
    },
    tags=("rappels",),
)
async def create_reminder(ctx: ToolContext, *, text: str, when: str) -> ToolResult:
    if ctx.reminders is None:
        return ToolResult.failure(
            summary="Le stockage des rappels n'est pas disponible; le rappel n'a pas ete cree."
        )
    try:
        window = resolve_date_expression(when, ctx.timezone)
    except ValueError:
        return ToolResult.failure(
            summary=(
                f"Je ne comprends pas le moment '{when}'. Demande une precision "
                "a l'utilisateur au lieu de choisir une date arbitraire."
            )
        )
    reminder = ctx.reminders.create(
        text=text,
        due_at=window.start.isoformat(),
        due_label=window.label,
        org_id=ctx.organization,
    )
    human = format_datetime_fr(window.start, ctx.timezone)
    return ToolResult.success(
        summary=f"Rappel enregistre pour {human}: {text}",
        data=reminder.as_dict(),
        display="reminder",
    )


@registry.tool(
    name="list_reminders",
    description="Liste les rappels en attente, du plus proche au plus lointain.",
    permission=PermissionLevel.READ,
    schema={
        "type": "object",
        "properties": {
            "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Nombre max."}
        },
    },
    tags=("rappels",),
)
async def list_reminders(ctx: ToolContext, *, limit: int = 10) -> ToolResult:
    if ctx.reminders is None:
        return ToolResult.failure(summary="Le stockage des rappels n'est pas disponible.")
    pending = ctx.reminders.list_pending(org_id=ctx.organization, limit=limit)
    if not pending:
        return ToolResult.success(summary="Aucun rappel en attente.", data={"reminders": []})

    lines = []
    items = []
    for index, reminder in enumerate(pending, start=1):
        label = f"{reminder.text} ({reminder.due_label or reminder.due_at[:16]})"
        lines.append(f"{index}. {label}")
        items.append(
            ReferencedItem(
                kind="reminder", ref_id=reminder.id, label=label, payload=reminder.as_dict()
            )
        )
    ctx.session.set_focus("reminder", items)
    return ToolResult.success(
        summary=f"{len(pending)} rappel(s) en attente:\n" + "\n".join(lines),
        data={"reminders": [r.as_dict() for r in pending]},
        display="list",
    )


@registry.tool(
    name="complete_reminder",
    description=(
        "Marque un rappel comme fait. Utiliser l'identifiant retourne par list_reminders."
    ),
    permission=PermissionLevel.LOW_WRITE,
    schema={
        "type": "object",
        "properties": {
            "reminder_id": {"type": "string", "description": "Identifiant du rappel."}
        },
        "required": ["reminder_id"],
    },
    tags=("rappels",),
)
async def complete_reminder(ctx: ToolContext, *, reminder_id: str) -> ToolResult:
    if ctx.reminders is None:
        return ToolResult.failure(summary="Le stockage des rappels n'est pas disponible.")
    if not ctx.reminders.complete(reminder_id):
        return ToolResult.failure(summary=f"Aucun rappel avec l'identifiant {reminder_id}.")
    return ToolResult.success(summary="Rappel marque comme fait.", data={"id": reminder_id})
