"""Outils de memoire persistante.

Contrainte de fiabilite: on n'ecrit jamais un souvenir sans source explicite,
et `recall_memory` retourne la source de chaque element pour que JARVIS puisse
justifier ce qu'il avance.
"""

from __future__ import annotations

from jarvis_core.security.permissions import PermissionLevel
from jarvis_core.tools.base import Citation, ToolContext, ToolResult
from jarvis_core.tools.registry import registry


@registry.tool(
    name="remember_fact",
    description=(
        "Enregistre durablement une information que l'utilisateur veut que tu retiennes "
        "(personne, entreprise, preference, decision datee). "
        "N'enregistre que ce que l'utilisateur a reellement dit ou ce qui provient d'une "
        "source verifiable: jamais une deduction presentee comme un fait."
    ),
    permission=PermissionLevel.LOW_WRITE,
    feature_flag="persistent_memory",
    schema={
        "type": "object",
        "properties": {
            "fact": {
                "type": "string",
                "description": "L'information a retenir.",
                "maxLength": 1000,
            },
            "subject": {
                "type": "string",
                "description": "Entite concernee (personne, entreprise, projet).",
                "maxLength": 120,
            },
            "kind": {
                "type": "string",
                "enum": ["personal", "business", "event", "preference"],
                "description": "Type de memoire.",
            },
            "source": {
                "type": "string",
                "description": "D'ou vient l'information: 'utilisateur', 'courriel', 'document'.",
                "maxLength": 120,
            },
            "confidence": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "description": "Niveau de confiance, 1 = certitude.",
            },
        },
        "required": ["fact"],
    },
    tags=("memoire",),
)
async def remember_fact(
    ctx: ToolContext,
    *,
    fact: str,
    subject: str = "",
    kind: str = "personal",
    source: str = "utilisateur",
    confidence: float = 0.9,
) -> ToolResult:
    if ctx.memory_store is None:
        ctx.session.add_fact(fact, source=source, confidence=confidence)
        return ToolResult.success(
            summary="Retenu pour cette conversation seulement (memoire persistante desactivee).",
            data={"persisted": False},
        )
    memory = ctx.memory_store.add(
        content=fact,
        subject=subject,
        kind=kind,
        source=source,
        confidence=confidence,
        org_id=ctx.organization,
    )
    return ToolResult.success(
        summary=f"Retenu: {fact}",
        data={"persisted": True, **memory.as_dict()},
    )


@registry.tool(
    name="recall_memory",
    description=(
        "Cherche dans la memoire persistante (personnes, entreprises, preferences, decisions). "
        "A utiliser des qu'une question porte sur un fait deja connu de l'utilisateur."
    ),
    permission=PermissionLevel.READ,
    feature_flag="persistent_memory",
    schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Sujet recherche.", "maxLength": 300},
            "kind": {
                "type": "string",
                "enum": ["personal", "business", "event", "preference"],
                "description": "Restreindre a un type de memoire.",
            },
            "limit": {"type": "integer", "minimum": 1, "maximum": 20},
        },
        "required": ["query"],
    },
    tags=("memoire",),
)
async def recall_memory(
    ctx: ToolContext, *, query: str, kind: str | None = None, limit: int = 6
) -> ToolResult:
    if ctx.memory_store is None:
        return ToolResult.failure(summary="La memoire persistante est desactivee.")
    results = ctx.memory_store.search(
        query, org_id=ctx.organization, kind=kind, limit=limit
    )
    if not results:
        return ToolResult.success(
            summary=(
                f"Rien en memoire au sujet de '{query}'. "
                "Dis-le clairement plutot que de deviner."
            ),
            data={"memories": []},
        )
    lines = [memory.as_line() for memory in results]
    citations = [
        Citation(
            label=f"Memoire — {memory.source}",
            kind="memory",
            locator=memory.id,
            timestamp=memory.created_at,
        )
        for memory in results
    ]
    return ToolResult.success(
        summary="En memoire:\n" + "\n".join(f"- {line}" for line in lines),
        data={"memories": [memory.as_dict() for memory in results]},
        citations=citations,
        display="list",
    )


@registry.tool(
    name="forget_memory",
    description=(
        "Supprime definitivement un souvenir. Action sensible: exige une confirmation."
    ),
    permission=PermissionLevel.SENSITIVE,
    feature_flag="persistent_memory",
    schema={
        "type": "object",
        "properties": {
            "memory_id": {
                "type": "string",
                "description": "Identifiant retourne par recall_memory.",
            }
        },
        "required": ["memory_id"],
    },
    tags=("memoire",),
)
async def forget_memory(ctx: ToolContext, *, memory_id: str) -> ToolResult:
    if ctx.memory_store is None:
        return ToolResult.failure(summary="La memoire persistante est desactivee.")
    if not ctx.memory_store.forget(memory_id):
        return ToolResult.failure(summary=f"Aucun souvenir avec l'identifiant {memory_id}.")
    return ToolResult.success(summary="Souvenir supprime.", data={"id": memory_id})
