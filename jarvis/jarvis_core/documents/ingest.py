"""Pipeline d'indexation: fichier -> segments -> morceaux -> index.

L'indexation est **idempotente**: un fichier inchange n'est pas reindexe.  On
compare l'empreinte du contenu, pas la date de modification, parce qu'une
synchronisation ou une copie suffit a changer la date sans toucher au texte.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from jarvis_core.documents.chunk import chunk_segments
from jarvis_core.documents.extract import SUPPORTED_SUFFIXES, Segment, extract, is_supported
from jarvis_core.documents.store import DocumentStore
from jarvis_core.errors import DocumentError

logger = logging.getLogger(__name__)


@dataclass
class IngestReport:
    """Ce qui a ete indexe, ignore, ou a echoue.

    Les echecs sont nommes un par un: un dossier « indexe » qui a silencieux-
    ement saute trois fichiers illisibles est un piege a fiabilite.
    """

    indexed: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)

    _chunks: int = 0

    @property
    def chunk_total(self) -> int:
        return self._chunks

    def add_chunks(self, count: int) -> None:
        self._chunks += count

    def summary(self) -> str:
        parts = []
        if self.indexed:
            parts.append(f"{len(self.indexed)} document(s) indexe(s)")
        if self.unchanged:
            parts.append(f"{len(self.unchanged)} inchange(s)")
        if self.skipped:
            parts.append(f"{len(self.skipped)} ignore(s)")
        if self.failed:
            parts.append(f"{len(self.failed)} en echec")
        return ", ".join(parts) if parts else "aucun document trouve"

    def as_dict(self) -> dict[str, object]:
        return {
            "indexed": self.indexed,
            "unchanged": self.unchanged,
            "skipped": [{"name": n, "reason": r} for n, r in self.skipped],
            "failed": [{"name": n, "reason": r} for n, r in self.failed],
            "chunks": self._chunks,
        }


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ingest_file(
    store: DocumentStore,
    path: Path | str,
    *,
    org_id: str = "PERSONAL",
    force: bool = False,
) -> tuple[str, int]:
    """Indexe un fichier. Retourne (etat, nombre de morceaux).

    Etat vaut `indexed` ou `unchanged`.
    """
    file = Path(path).expanduser().resolve()
    raw = file.read_bytes() if file.exists() else b""
    if not raw:
        raise DocumentError(
            f"fichier vide ou absent: {file}",
            user_message=f"{file.name} est vide ou introuvable.",
        )
    digest = content_hash(raw)

    existing = store.find_by_identity(source="local", path=str(file))
    if existing and existing.content_hash == digest and not force:
        return "unchanged", existing.chunk_count

    segments = extract(file)
    chunks = chunk_segments(segments)
    if not chunks:
        raise DocumentError(
            f"aucun morceau produit pour {file}",
            user_message=f"{file.name} ne contient rien d'indexable.",
        )

    modified = datetime.fromtimestamp(file.stat().st_mtime, tz=UTC).isoformat()
    store.replace(
        title=file.stem,
        source="local",
        path=str(file),
        content_hash=digest,
        chunks=[(c.text, c.locator) for c in chunks],
        mime=file.suffix.lower().lstrip("."),
        size=len(raw),
        org_id=org_id,
        modified_at=modified,
    )
    return "indexed", len(chunks)


def ingest_directory(
    store: DocumentStore,
    directory: Path | str,
    *,
    org_id: str = "PERSONAL",
    force: bool = False,
    recursive: bool = True,
) -> IngestReport:
    """Indexe tous les fichiers geres d'un dossier."""
    root = Path(directory).expanduser()
    report = IngestReport()
    if not root.exists():
        raise DocumentError(
            f"dossier absent: {root}",
            user_message=(
                f"Le dossier {root} n'existe pas. "
                "Cree-le, ou corrige JARVIS_DOCUMENTS_DIR dans le fichier .env."
            ),
        )
    if not root.is_dir():
        raise DocumentError(
            f"pas un dossier: {root}",
            user_message=f"{root} n'est pas un dossier.",
        )

    for file in _walk(root, recursive=recursive):
        if not is_supported(file):
            report.skipped.append((file.name, f"format non gere ({file.suffix or 'aucune'})"))
            continue
        try:
            state, chunks = ingest_file(store, file, org_id=org_id, force=force)
        except DocumentError as exc:
            logger.warning("indexation echouee pour %s: %s", file, exc)
            report.failed.append((file.name, exc.user_message))
            continue
        if state == "indexed":
            report.indexed.append(file.name)
            report.add_chunks(chunks)
        else:
            report.unchanged.append(file.name)
    return report


def ingest_segments(
    store: DocumentStore,
    *,
    title: str,
    segments: Iterable[Segment],
    source: str,
    content_hash_value: str,
    external_id: str = "",
    url: str = "",
    mime: str = "",
    org_id: str = "PERSONAL",
    modified_at: str = "",
) -> int:
    """Indexe des segments deja extraits (utilise par la synchronisation Drive)."""
    chunks = chunk_segments(list(segments))
    if not chunks:
        raise DocumentError(
            f"aucun morceau produit pour {title}",
            user_message=f"« {title} » ne contient rien d'indexable.",
        )
    store.replace(
        title=title,
        source=source,
        external_id=external_id,
        url=url,
        mime=mime,
        content_hash=content_hash_value,
        chunks=[(c.text, c.locator) for c in chunks],
        org_id=org_id,
        modified_at=modified_at,
    )
    return len(chunks)


def _walk(root: Path, *, recursive: bool) -> list[Path]:
    pattern = "**/*" if recursive else "*"
    files = [
        p
        for p in sorted(root.glob(pattern))
        if p.is_file() and not p.name.startswith(".") and "/." not in str(p)
    ]
    # Les formats geres d'abord: le rapport se lit mieux.
    return sorted(files, key=lambda p: (p.suffix.lower() not in SUPPORTED_SUFFIXES, str(p)))
