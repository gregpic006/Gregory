"""Stockage et recherche des documents.

La recherche est **hybride**: un index lexical (FTS5) et, quand un modele est
disponible, une recherche par vecteurs.  Les deux classements sont fusionnes
par rang reciproque (RRF), qui a l'avantage de ne pas exiger que deux scores
de natures differentes soient comparables entre eux.

Chaque resultat sait d'ou il vient — document, page — pour que toute phrase
avancee par JARVIS puisse etre verifiee.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from jarvis_core.documents.embeddings import EmbeddingProvider, cosine, pack, unpack
from jarvis_core.persistence.db import Database

logger = logging.getLogger(__name__)

#: Constante de la fusion par rang reciproque.  60 est la valeur de la
#: publication d'origine (Cormack et al.), robuste en pratique.
RRF_K = 60
#: Nombre de candidats pris dans chaque classement avant fusion.
CANDIDATES = 40

_FTS_SAFE = re.compile(r"[^\w\sÀ-ÿ'-]", re.UNICODE)


@dataclass
class Document:
    """Un document indexe."""

    id: str
    title: str
    source: str
    path: str = ""
    external_id: str = ""
    url: str = ""
    mime: str = ""
    content_hash: str = ""
    bytes: int = 0
    chunk_count: int = 0
    org_id: str = "PERSONAL"
    modified_at: str = ""
    indexed_at: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "source": self.source,
            "path": self.path,
            "url": self.url,
            "chunk_count": self.chunk_count,
            "bytes": self.bytes,
            "modified_at": self.modified_at,
            "indexed_at": self.indexed_at,
        }


@dataclass
class SearchHit:
    """Un morceau pertinent, avec sa provenance."""

    chunk_id: str
    document_id: str
    title: str
    locator: str
    text: str
    score: float
    url: str = ""
    matched_by: tuple[str, ...] = field(default_factory=tuple)
    """« lexical », « semantique », ou les deux."""

    def as_dict(self) -> dict[str, Any]:
        return {
            "document_id": self.document_id,
            "title": self.title,
            "locator": self.locator,
            "text": self.text,
            "score": round(self.score, 4),
            "matched_by": list(self.matched_by),
            "url": self.url,
        }


@dataclass
class SearchOutcome:
    """Resultat d'une recherche, avec ce qui a reellement tourne.

    `modes` est la pour l'honnetete: si le modele semantique n'est pas charge,
    JARVIS doit pouvoir dire « j'ai cherche les mots exacts » plutot que de
    laisser croire qu'il a compris le sens de la question.
    """

    hits: list[SearchHit]
    modes: tuple[str, ...]
    indexed_documents: int


class DocumentStore:
    """Depot des documents et de leurs morceaux.

    Le fournisseur d'embeddings peut etre passe directement, ou sous forme de
    fonction resolue au premier usage.  Le chargement paresseux evite qu'un
    `jarvis serve` bloque plusieurs minutes sur le telechargement d'un modele
    de 220 Mo alors que personne n'a encore rien cherche.
    """

    def __init__(
        self,
        db: Database,
        embeddings: EmbeddingProvider | Callable[[], EmbeddingProvider | None] | None = None,
    ) -> None:
        self.db = db
        self._embeddings_source = embeddings
        self._resolved: EmbeddingProvider | None = None
        self._resolution_done = not callable(embeddings)
        if self._resolution_done and embeddings is not None:
            self._resolved = embeddings  # type: ignore[assignment]

    @property
    def embeddings(self) -> EmbeddingProvider | None:
        """Fournisseur effectif, resolu au plus tard au premier appel.

        Retourne None quand la recherche semantique n'est pas disponible: la
        valeur commande directement ce que `search` annonce avoir fait.
        """
        if not self._resolution_done:
            self._resolution_done = True
            source = self._embeddings_source
            if callable(source):
                self._resolved = source()
        return self._resolved

    # ------------------------------------------------------------------ ecriture

    def find_by_identity(
        self, *, source: str, path: str = "", external_id: str = ""
    ) -> Document | None:
        row = self.db.query_one(
            "SELECT * FROM documents WHERE source = ? AND path = ? AND external_id = ?",
            (source, path, external_id),
        )
        return _to_document(row) if row else None

    def replace(
        self,
        *,
        title: str,
        source: str,
        chunks: list[tuple[str, str]],
        content_hash: str,
        path: str = "",
        external_id: str = "",
        url: str = "",
        mime: str = "",
        size: int = 0,
        org_id: str = "PERSONAL",
        modified_at: str = "",
    ) -> Document:
        """Indexe un document, en remplacant integralement sa version precedente.

        Args:
            chunks: couples (texte, localisation).
        """
        existing = self.find_by_identity(source=source, path=path, external_id=external_id)
        document_id = existing.id if existing else f"doc_{uuid.uuid4().hex[:10]}"
        now = datetime.now(UTC).isoformat()

        vectors: list[bytes | None] = [None] * len(chunks)
        provider = self.embeddings
        if provider is not None and chunks:
            try:
                computed = provider.embed_documents([text for text, _ in chunks])
                vectors = [pack(v) for v in computed]
            except Exception as exc:  # noqa: BLE001 - l'indexation lexicale doit survivre
                logger.warning("vecteurs non calcules pour %s: %s", title, exc)

        with self.db.cursor() as cur:
            if existing:
                cur.execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
                cur.execute("DELETE FROM documents WHERE id = ?", (document_id,))
            cur.execute(
                "INSERT INTO documents (id, org_id, title, source, path, external_id, url,"
                " mime, content_hash, bytes, chunk_count, modified_at, indexed_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    document_id,
                    org_id,
                    title,
                    source,
                    path,
                    external_id,
                    url,
                    mime,
                    content_hash,
                    size,
                    len(chunks),
                    modified_at,
                    now,
                ),
            )
            for position, ((text, locator), vector) in enumerate(zip(chunks, vectors, strict=True)):
                cur.execute(
                    "INSERT INTO document_chunks (id, document_id, position, locator, text,"
                    " embedding) VALUES (?,?,?,?,?,?)",
                    (f"ch_{uuid.uuid4().hex[:12]}", document_id, position, locator, text, vector),
                )

        return Document(
            id=document_id,
            title=title,
            source=source,
            path=path,
            external_id=external_id,
            url=url,
            mime=mime,
            content_hash=content_hash,
            bytes=size,
            chunk_count=len(chunks),
            org_id=org_id,
            modified_at=modified_at,
            indexed_at=now,
        )

    def delete(self, document_id: str) -> bool:
        if not self.db.query_one("SELECT id FROM documents WHERE id = ?", (document_id,)):
            return False
        self.db.execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
        self.db.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        return True

    # ------------------------------------------------------------------ lecture

    def list_documents(self, *, org_id: str = "", limit: int = 100) -> list[Document]:
        if org_id:
            rows = self.db.query(
                "SELECT * FROM documents WHERE org_id = ? ORDER BY indexed_at DESC LIMIT ?",
                (org_id, limit),
            )
        else:
            rows = self.db.query(
                "SELECT * FROM documents ORDER BY indexed_at DESC LIMIT ?", (limit,)
            )
        return [_to_document(row) for row in rows]

    def get(self, document_id: str) -> Document | None:
        row = self.db.query_one("SELECT * FROM documents WHERE id = ?", (document_id,))
        return _to_document(row) if row else None

    def full_text(self, document_id: str) -> str:
        rows = self.db.query(
            "SELECT text FROM document_chunks WHERE document_id = ? ORDER BY position",
            (document_id,),
        )
        return "\n\n".join(str(row["text"]) for row in rows)

    def count(self) -> int:
        row = self.db.query_one("SELECT COUNT(*) AS n FROM documents")
        return int(row["n"]) if row else 0

    # ------------------------------------------------------------------ recherche

    def search(self, query: str, *, limit: int = 5, org_id: str = "") -> SearchOutcome:
        """Recherche hybride, avec la liste des modes reellement utilises."""
        total = self.count()
        cleaned = query.strip()
        if not cleaned or total == 0:
            return SearchOutcome(hits=[], modes=(), indexed_documents=total)

        provider = self.embeddings
        lexical = self._lexical(cleaned, org_id=org_id)
        semantic = self._semantic(cleaned, org_id=org_id, provider=provider)

        modes: list[str] = ["lexical"]
        if provider is not None:
            modes.append("semantique")

        fused = _fuse(lexical, semantic)
        return SearchOutcome(
            hits=fused[:limit], modes=tuple(modes), indexed_documents=total
        )

    def _lexical(self, query: str, *, org_id: str) -> list[SearchHit]:
        expression = _to_fts_query(query)
        if not expression:
            return []
        sql = (
            "SELECT c.id, c.document_id, c.locator, c.text, d.title, d.url,"
            " bm25(document_chunks_fts) AS rank"
            " FROM document_chunks_fts"
            " JOIN document_chunks c ON c.rowid = document_chunks_fts.rowid"
            " JOIN documents d ON d.id = c.document_id"
            " WHERE document_chunks_fts MATCH ?"
        )
        params: list[Any] = [expression]
        if org_id:
            sql += " AND d.org_id = ?"
            params.append(org_id)
        sql += " ORDER BY rank LIMIT ?"
        params.append(CANDIDATES)

        try:
            rows = self.db.query(sql, tuple(params))
        except Exception as exc:  # noqa: BLE001 - syntaxe FTS refusee
            logger.warning("recherche lexicale impossible pour %r: %s", query, exc)
            return []

        return [
            SearchHit(
                chunk_id=str(row["id"]),
                document_id=str(row["document_id"]),
                title=str(row["title"]),
                locator=str(row["locator"]),
                text=str(row["text"]),
                url=str(row["url"]),
                # bm25 renvoie un score negatif: plus c'est bas, mieux c'est.
                score=-float(row["rank"]),
                matched_by=("lexical",),
            )
            for row in rows
        ]

    def _semantic(
        self, query: str, *, org_id: str, provider: EmbeddingProvider | None
    ) -> list[SearchHit]:
        if provider is None:
            return []
        try:
            vector = provider.embed_query(query)
        except Exception as exc:  # noqa: BLE001 - le lexical doit survivre
            logger.warning("vecteur de requete non calcule: %s", exc)
            return []

        sql = (
            "SELECT c.id, c.document_id, c.locator, c.text, c.embedding, d.title, d.url"
            " FROM document_chunks c JOIN documents d ON d.id = c.document_id"
            " WHERE c.embedding IS NOT NULL"
        )
        params: list[Any] = []
        if org_id:
            sql += " AND d.org_id = ?"
            params.append(org_id)
        rows = self.db.query(sql, tuple(params))

        scored: list[SearchHit] = []
        for row in rows:
            similarity = cosine(vector, unpack(bytes(row["embedding"])))
            scored.append(
                SearchHit(
                    chunk_id=str(row["id"]),
                    document_id=str(row["document_id"]),
                    title=str(row["title"]),
                    locator=str(row["locator"]),
                    text=str(row["text"]),
                    url=str(row["url"]),
                    score=similarity,
                    matched_by=("semantique",),
                )
            )
        scored.sort(key=lambda hit: hit.score, reverse=True)
        return scored[:CANDIDATES]


def _fuse(lexical: list[SearchHit], semantic: list[SearchHit]) -> list[SearchHit]:
    """Fusion par rang reciproque de deux classements."""
    if not semantic:
        return lexical
    if not lexical:
        return semantic

    scores: dict[str, float] = {}
    hits: dict[str, SearchHit] = {}
    origins: dict[str, set[str]] = {}

    for ranking in (lexical, semantic):
        for rank, hit in enumerate(ranking, start=1):
            scores[hit.chunk_id] = scores.get(hit.chunk_id, 0.0) + 1.0 / (RRF_K + rank)
            hits.setdefault(hit.chunk_id, hit)
            origins.setdefault(hit.chunk_id, set()).update(hit.matched_by)

    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    fused: list[SearchHit] = []
    for chunk_id, score in ordered:
        hit = hits[chunk_id]
        fused.append(
            SearchHit(
                chunk_id=hit.chunk_id,
                document_id=hit.document_id,
                title=hit.title,
                locator=hit.locator,
                text=hit.text,
                url=hit.url,
                score=score,
                matched_by=tuple(sorted(origins[chunk_id])),
            )
        )
    return fused


def _to_fts_query(query: str) -> str:
    """Transforme une question en expression FTS5 sure.

    On ne passe jamais la saisie brute a MATCH: un guillemet ou un operateur
    suffirait a faire echouer la requete, voire a changer son sens.
    """
    words = [w for w in _FTS_SAFE.sub(" ", query).split() if len(w) > 1]
    if not words:
        return ""
    # OR plutot que AND: une question en langage naturel contient des mots
    # qui n'apparaissent nulle part (« combien », « est-ce que »).  bm25 se
    # charge de remonter les morceaux qui en contiennent le plus.
    return " OR ".join(f'"{word}"' for word in words)


def _to_document(row: Any) -> Document:
    return Document(
        id=str(row["id"]),
        title=str(row["title"]),
        source=str(row["source"]),
        path=str(row["path"]),
        external_id=str(row["external_id"]),
        url=str(row["url"]),
        mime=str(row["mime"]),
        content_hash=str(row["content_hash"]),
        bytes=int(row["bytes"]),
        chunk_count=int(row["chunk_count"]),
        org_id=str(row["org_id"]),
        modified_at=str(row["modified_at"]),
        indexed_at=str(row["indexed_at"]),
    )
