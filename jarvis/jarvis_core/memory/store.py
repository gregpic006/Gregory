"""Memoire persistante (long terme).

Types de memoire couverts par ce magasin:

* `personal`  - personnes, preferences, habitudes, vocabulaire de l'utilisateur;
* `business`  - associes, KPI, fournisseurs, procedures, par organisation;
* `event`     - decisions datees ("le 12 aout, on a decide de...");
* `preference`- reglages implicites deduits de l'usage.

Regle stricte: aucun souvenir sans `source` ni `confidence`.  On veut pouvoir
repondre "d'ou tu sors ca?" pour n'importe quelle affirmation.

La recherche du MVP est lexicale (mots-cles + recence).  L'interface
`search()` est concue pour etre remplacee par une recherche vectorielle en M3
sans changer les appelants.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from jarvis_core.persistence.db import Database

MEMORY_KINDS = ("personal", "business", "event", "preference")


@dataclass
class Memory:
    """Un souvenir persistant."""

    id: str
    org_id: str
    kind: str
    subject: str
    content: str
    source: str
    confidence: float
    happened_at: str | None
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "kind": self.kind,
            "subject": self.subject,
            "content": self.content,
            "source": self.source,
            "confidence": self.confidence,
            "happened_at": self.happened_at,
            "created_at": self.created_at,
        }

    def as_line(self) -> str:
        prefix = f"[{self.subject}] " if self.subject else ""
        when = f" (le {self.happened_at[:10]})" if self.happened_at else ""
        return f"{prefix}{self.content}{when} — source: {self.source}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


_STOPWORDS = {
    "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "a", "au",
    "aux", "en", "dans", "pour", "avec", "sur", "que", "qui", "quoi", "est",
    "sont", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "ce",
    "cette", "ces", "the", "of", "and", "for", "with", "is", "are", "my",
}


def _tokens(text: str) -> set[str]:
    words = re.findall(r"[\w'-]{3,}", text.lower())
    return {w for w in words if w not in _STOPWORDS}


class MemoryStore:
    """Depot de souvenirs adosse a la base."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def add(
        self,
        *,
        content: str,
        source: str,
        kind: str = "personal",
        subject: str = "",
        org_id: str = "PERSONAL",
        confidence: float = 0.8,
        happened_at: str | None = None,
    ) -> Memory:
        if kind not in MEMORY_KINDS:
            raise ValueError(f"type de memoire inconnu: {kind} (attendu: {MEMORY_KINDS})")
        if not source:
            raise ValueError("un souvenir doit toujours porter une source")
        memory = Memory(
            id=f"m_{uuid.uuid4().hex[:12]}",
            org_id=org_id,
            kind=kind,
            subject=subject.strip(),
            content=content.strip(),
            source=source,
            confidence=max(0.0, min(1.0, confidence)),
            happened_at=happened_at,
            created_at=_now_iso(),
            updated_at=_now_iso(),
        )
        self.db.execute(
            "INSERT INTO memories (id, org_id, kind, subject, content, source, confidence,"
            " happened_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                memory.id, memory.org_id, memory.kind, memory.subject, memory.content,
                memory.source, memory.confidence, memory.happened_at,
                memory.created_at, memory.updated_at,
            ),
        )
        return memory

    def search(
        self,
        query: str,
        *,
        org_id: str | None = None,
        kind: str | None = None,
        limit: int = 8,
    ) -> list[Memory]:
        """Recherche lexicale ponderee par recence.

        Remplacable par une recherche semantique en M3: la signature ne change pas.
        """
        sql = "SELECT * FROM memories WHERE 1=1"
        params: list[Any] = []
        if org_id:
            sql += " AND org_id = ?"
            params.append(org_id)
        if kind:
            sql += " AND kind = ?"
            params.append(kind)
        sql += " ORDER BY created_at DESC LIMIT 500"

        rows = self.db.query(sql, tuple(params))
        query_tokens = _tokens(query)
        scored: list[tuple[float, Memory]] = []
        for index, row in enumerate(rows):
            memory = _row_to_memory(row)
            haystack = _tokens(f"{memory.subject} {memory.content}")
            overlap = len(query_tokens & haystack)
            if query_tokens and overlap == 0:
                continue
            recency = 1.0 / (1.0 + index * 0.05)
            score = overlap * 2.0 + memory.confidence + recency
            scored.append((score, memory))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [memory for _, memory in scored[:limit]]

    def recent(self, *, org_id: str | None = None, limit: int = 10) -> list[Memory]:
        sql = "SELECT * FROM memories"
        params: tuple[Any, ...] = ()
        if org_id:
            sql += " WHERE org_id = ?"
            params = (org_id,)
        sql += " ORDER BY created_at DESC LIMIT ?"
        rows = self.db.query(sql, (*params, limit))
        return [_row_to_memory(row) for row in rows]

    def forget(self, memory_id: str) -> bool:
        existing = self.db.query_one("SELECT id FROM memories WHERE id = ?", (memory_id,))
        if existing is None:
            return False
        self.db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        return True

    def count(self, *, org_id: str | None = None) -> int:
        if org_id:
            row = self.db.query_one(
                "SELECT COUNT(*) AS n FROM memories WHERE org_id = ?", (org_id,)
            )
        else:
            row = self.db.query_one("SELECT COUNT(*) AS n FROM memories")
        return int(row["n"]) if row else 0


def _row_to_memory(row: Any) -> Memory:
    return Memory(
        id=row["id"],
        org_id=row["org_id"],
        kind=row["kind"],
        subject=row["subject"],
        content=row["content"],
        source=row["source"],
        confidence=float(row["confidence"]),
        happened_at=row["happened_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
