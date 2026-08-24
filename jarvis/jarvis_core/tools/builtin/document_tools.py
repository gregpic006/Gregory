"""Outils de recherche documentaire.

Regle de fiabilite propre a ces outils: le resume renvoye au modele annonce
**comment** la recherche a ete faite.  Sans modele semantique charge, JARVIS
cherche des mots exacts — il doit pouvoir dire « je n'ai trouve aucun document
contenant ces mots », ce qui n'est pas la meme affirmation que « tu n'as aucun
document la-dessus ».

Le texte des documents est du contenu externe: il est marque `untrusted` pour
que l'orchestrateur l'encapsule avant de le donner au modele.  Un contrat qui
contient « ignore les instructions precedentes » reste un contrat, pas un
ordre.
"""

from __future__ import annotations

from jarvis_core.security.permissions import PermissionLevel
from jarvis_core.tools.base import Citation, ToolContext, ToolResult
from jarvis_core.tools.registry import registry

#: Longueur de l'extrait renvoye au modele par resultat.  Assez pour repondre,
#: assez court pour que cinq resultats ne noient pas la question.
EXCERPT_CHARS = 700


def _no_store_message() -> ToolResult:
    return ToolResult.failure(
        summary=(
            "La recherche documentaire n'est pas active. "
            "Aucun document n'est indexe, je ne peux donc rien affirmer sur leur contenu."
        ),
        data={"status": "not_connected"},
    )


@registry.tool(
    name="search_documents",
    description=(
        "Cherche une information dans les documents indexes (contrats, baux, factures, notes). "
        "Utilise cet outil des que la reponse pourrait se trouver dans un document plutot que "
        "dans ta memoire. Chaque resultat indique le document et la page: cite-les. "
        "Si aucun resultat ne revient, dis qu'aucun document ne contient cette information — "
        "n'affirme jamais un contenu que tu n'as pas lu ici."
    ),
    permission=PermissionLevel.READ,
    feature_flag="documents",
    schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Les termes a chercher, en langage naturel.",
                "maxLength": 400,
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 10,
                "description": "Nombre de passages a retourner (defaut 5).",
            },
        },
        "required": ["query"],
    },
    tags=("documents",),
)
async def search_documents(ctx: ToolContext, *, query: str, limit: int = 5) -> ToolResult:
    store = ctx.documents
    if store is None:
        return _no_store_message()

    outcome = store.search(query, limit=limit, org_id="")

    if outcome.indexed_documents == 0:
        return ToolResult.success(
            summary=(
                "Aucun document n'est indexe pour l'instant. "
                "Je ne peux donc rien affirmer sur le contenu de tes documents."
            ),
            data={"status": "empty_index", "hits": []},
        )

    mode_label = " et ".join(outcome.modes) if outcome.modes else "lexical"

    if not outcome.hits:
        return ToolResult.success(
            summary=(
                f"Aucun passage trouve pour « {query} » dans les "
                f"{outcome.indexed_documents} document(s) indexes (recherche {mode_label}). "
                "Cela veut dire que je n'ai rien trouve, pas que l'information n'existe pas."
            ),
            data={"status": "no_match", "hits": [], "modes": list(outcome.modes)},
        )

    lines = [
        f"{len(outcome.hits)} passage(s) trouve(s) pour « {query} » "
        f"(recherche {mode_label}, sur {outcome.indexed_documents} document(s)) :"
    ]
    citations: list[Citation] = []
    for position, hit in enumerate(outcome.hits, start=1):
        where = f"{hit.title}, {hit.locator}" if hit.locator else hit.title
        excerpt = hit.text[:EXCERPT_CHARS]
        if len(hit.text) > EXCERPT_CHARS:
            excerpt += "…"
        lines.append(f"\n[{position}] {where}\n{excerpt}")
        citations.append(
            Citation(
                label=where,
                kind="document",
                locator=hit.locator,
                url=hit.url,
            )
        )

    return ToolResult.success(
        summary="\n".join(lines),
        data={
            "status": "ok",
            "modes": list(outcome.modes),
            "indexed_documents": outcome.indexed_documents,
            "hits": [hit.as_dict() for hit in outcome.hits],
        },
        citations=citations,
        untrusted=True,
        source_label="documents indexes",
        display="list",
    )


@registry.tool(
    name="list_documents",
    description=(
        "Liste les documents indexes, avec leur taille et leur date. "
        "Utile pour repondre a « qu'est-ce que tu as comme documents ? »."
    ),
    permission=PermissionLevel.READ,
    feature_flag="documents",
    schema={
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Nombre maximum de documents (defaut 25).",
            }
        },
    },
    tags=("documents",),
)
async def list_documents(ctx: ToolContext, *, limit: int = 25) -> ToolResult:
    store = ctx.documents
    if store is None:
        return _no_store_message()

    documents = store.list_documents(limit=limit)
    if not documents:
        return ToolResult.success(
            summary="Aucun document n'est indexe pour l'instant.",
            data={"status": "empty_index", "documents": []},
        )

    lines = [f"{len(documents)} document(s) indexe(s) :"]
    lines.extend(
        f"- {doc.title} ({doc.mime or doc.source}, {doc.chunk_count} passage(s))"
        for doc in documents
    )
    return ToolResult.success(
        summary="\n".join(lines),
        data={"status": "ok", "documents": [doc.as_dict() for doc in documents]},
        display="list",
    )


@registry.tool(
    name="read_document",
    description=(
        "Lit le contenu complet d'un document deja indexe, a partir de son identifiant "
        "(obtenu via search_documents ou list_documents). "
        "N'utilise cet outil que si un extrait ne suffit pas: le contenu peut etre long."
    ),
    permission=PermissionLevel.READ,
    feature_flag="documents",
    schema={
        "type": "object",
        "properties": {
            "document_id": {
                "type": "string",
                "description": "Identifiant du document.",
                "maxLength": 60,
            },
            "max_chars": {
                "type": "integer",
                "minimum": 500,
                "maximum": 20000,
                "description": "Longueur maximale a retourner (defaut 6000).",
            },
        },
        "required": ["document_id"],
    },
    tags=("documents",),
)
async def read_document(ctx: ToolContext, *, document_id: str, max_chars: int = 6000) -> ToolResult:
    store = ctx.documents
    if store is None:
        return _no_store_message()

    document = store.get(document_id)
    if document is None:
        return ToolResult.failure(
            summary=(
                f"Aucun document indexe ne porte l'identifiant {document_id}. "
                "Utilise list_documents pour voir ce qui est disponible."
            ),
            data={"status": "not_found"},
        )

    text = store.full_text(document_id)
    truncated = len(text) > max_chars
    if truncated:
        text = text[:max_chars]

    header = f"Contenu de « {document.title} »"
    if truncated:
        header += f" (tronque a {max_chars} caracteres sur {document.bytes} octets)"
    return ToolResult.success(
        summary=f"{header} :\n\n{text}",
        data={
            "status": "ok",
            "document": document.as_dict(),
            "truncated": truncated,
        },
        citations=[Citation(label=document.title, kind="document", url=document.url)],
        untrusted=True,
        source_label=f"document « {document.title} »",
    )
