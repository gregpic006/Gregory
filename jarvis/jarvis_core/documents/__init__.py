"""Documents: extraction, decoupage, indexation et recherche (M3)."""

from jarvis_core.documents.embeddings import EmbeddingProvider, build_embedding_provider
from jarvis_core.documents.ingest import IngestReport, ingest_directory, ingest_file
from jarvis_core.documents.store import Document, DocumentStore, SearchHit, SearchOutcome

__all__ = [
    "Document",
    "DocumentStore",
    "EmbeddingProvider",
    "IngestReport",
    "SearchHit",
    "SearchOutcome",
    "build_embedding_provider",
    "ingest_directory",
    "ingest_file",
]
