"""Vecteurs semantiques — optionnels, jamais obligatoires.

JARVIS doit pouvoir chercher dans les documents **sans** modele d'embedding:
l'index lexical (FTS5) fonctionne hors ligne, sans telechargement, et repond
tres bien aux termes exacts.  Le modele semantique s'ajoute par-dessus pour
retrouver une idee formulee autrement (« combien on a vendu » -> « chiffre
d'affaires »).

D'ou la regle: si le modele est absent, la recherche continue en mode lexical
et **le dit**.  Elle ne fait jamais semblant de comprendre le sens.
"""

from __future__ import annotations

import logging
import struct
from typing import Protocol, runtime_checkable

from jarvis_core.errors import DocumentError

logger = logging.getLogger(__name__)

#: Petit (~220 Mo), multilingue, correct en francais.  Le choix privilegie ce
#: qui se telecharge une fois sur un portable plutot que le meilleur score
#: absolu: un modele de 2 Go qu'on n'installe jamais ne sert a rien.
DEFAULT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Transforme du texte en vecteurs."""

    @property
    def name(self) -> str: ...

    @property
    def dimension(self) -> int: ...

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class FastEmbedProvider:
    """Embeddings locaux via fastembed (ONNX, pas de PyTorch).

    Le modele se telecharge au premier usage puis reste en cache.  Aucune
    donnee ne quitte la machine.
    """

    def __init__(self, model_name: str = DEFAULT_MODEL, cache_dir: str = "") -> None:
        self._model_name = model_name
        try:
            from fastembed import TextEmbedding
        except ImportError as exc:
            raise DocumentError(
                "fastembed absent",
                user_message=(
                    "La recherche semantique n'est pas installee. "
                    "Installe-la avec: pip install fastembed"
                ),
            ) from exc

        try:
            self._model = TextEmbedding(
                model_name=model_name,
                cache_dir=cache_dir or None,
            )
        except Exception as exc:  # noqa: BLE001 - reseau, disque, modele inconnu
            raise DocumentError(
                f"modele d'embedding indisponible: {model_name} ({exc})",
                user_message=(
                    f"Je n'ai pas pu charger le modele de recherche semantique "
                    f"({model_name}). Verifie ta connexion Internet: il se telecharge "
                    "une seule fois (environ 220 Mo). En attendant, la recherche "
                    "fonctionne quand meme, mais sur les mots exacts seulement."
                ),
            ) from exc

        self._dimension = len(self.embed_query("dimension"))

    @property
    def name(self) -> str:
        return self._model_name

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        return [list(map(float, v)) for v in self._model.embed(texts)]

    def embed_query(self, text: str) -> list[float]:
        return [float(x) for x in next(iter(self._model.query_embed(text)))]


def pack(vector: list[float]) -> bytes:
    """Serialise un vecteur pour SQLite (float32, little endian)."""
    return struct.pack(f"<{len(vector)}f", *vector)


def unpack(blob: bytes) -> list[float]:
    """Deserialise un vecteur stocke."""
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))


def cosine(a: list[float], b: list[float]) -> float:
    """Similarite cosinus, sans dependance a numpy."""
    if len(a) != len(b) or not a:
        return 0.0
    dot = norm_a = norm_b = 0.0
    for x, y in zip(a, b, strict=True):
        dot += x * y
        norm_a += x * x
        norm_b += y * y
    if norm_a <= 0.0 or norm_b <= 0.0:
        return 0.0
    return dot / ((norm_a**0.5) * (norm_b**0.5))


def build_embedding_provider(
    *, enabled: bool, model_name: str = DEFAULT_MODEL, cache_dir: str = ""
) -> EmbeddingProvider | None:
    """Construit le fournisseur, ou None si la recherche reste lexicale.

    Un echec de chargement n'est pas fatal: on journalise et on retourne None.
    La recherche continuera en mode lexical, et l'annoncera.
    """
    if not enabled:
        return None
    try:
        provider = FastEmbedProvider(model_name=model_name, cache_dir=cache_dir)
    except DocumentError as exc:
        logger.warning("recherche semantique indisponible, repli lexical: %s", exc)
        return None
    logger.info(
        "recherche semantique active: %s (%s dimensions)", provider.name, provider.dimension
    )
    return provider
