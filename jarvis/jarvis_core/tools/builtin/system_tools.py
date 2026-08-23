"""Outils d'introspection du systeme.

Ils existent pour une raison precise: permettre a JARVIS de repondre
honnetement a "est-ce que tu peux lire mes courriels?" sans inventer.
"""

from __future__ import annotations

from jarvis_core.security.permissions import PermissionLevel
from jarvis_core.tools.base import ToolContext, ToolResult
from jarvis_core.tools.registry import registry

#: Etat declare de chaque integration prevue dans la feuille de route.
INTEGRATION_ROADMAP: dict[str, tuple[str, str]] = {
    "gmail": ("Gmail", "M2"),
    "calendar": ("Google Calendar", "M2"),
    "contacts": ("Google Contacts", "M2"),
    "drive": ("Google Drive", "M3"),
    "documents": ("Documents locaux (PDF, DOCX, XLSX)", "M3"),
    "restaurants": ("Donnees restaurants (POS, 7Shifts)", "M4"),
    "portail": ("Portail", "M4"),
    "web_search": ("Recherche web", "M4"),
    "computer_control": ("Controle de l'ordinateur", "M5"),
}


@registry.tool(
    name="get_capabilities",
    description=(
        "Liste ce qui est reellement branche et ce qui ne l'est pas. "
        "A appeler des que l'utilisateur demande une donnee dont tu n'as pas l'outil "
        "(courriels, calendrier, ventes, documents), pour repondre exactement ce qui manque."
    ),
    permission=PermissionLevel.READ,
    schema={"type": "object", "properties": {}},
    tags=("systeme",),
)
async def get_capabilities(ctx: ToolContext) -> ToolResult:
    features = ctx.settings.feature_map()
    connected: list[str] = []
    missing: list[str] = []
    for flag, (label, milestone) in INTEGRATION_ROADMAP.items():
        if features.get(flag, False):
            connected.append(label)
        else:
            missing.append(f"{label} (prevu {milestone})")

    lines = []
    if connected:
        lines.append("Connecte: " + ", ".join(connected) + ".")
    else:
        lines.append("Aucune integration externe n'est connectee pour l'instant.")
    lines.append("Pas encore connecte: " + ", ".join(missing) + ".")
    lines.append(
        "Capacites locales actives: heure et dates, calculs, rappels, memoire de session"
        + (", memoire persistante." if features.get("persistent_memory") else ".")
    )
    return ToolResult.success(
        summary="\n".join(lines),
        data={"connected": connected, "missing": missing, "features": features},
        display="capabilities",
    )
