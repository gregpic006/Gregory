"""Tarifs des modeles, en dollars US par million de tokens.

Source: tarification publique Anthropic (verifiee 2026-06).  Ces valeurs
servent uniquement a estimer les couts localement; elles n'ont aucun effet sur
la facturation reelle.  Un modele inconnu retourne un cout de 0 et est
journalise plutot que de faire echouer un tour.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from jarvis_core.llm.base import Usage

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelPrice:
    """Prix par million de tokens."""

    input_per_mtok: float
    output_per_mtok: float


PRICES: dict[str, ModelPrice] = {
    "claude-opus-5": ModelPrice(5.00, 25.00),
    "claude-opus-4-8": ModelPrice(5.00, 25.00),
    "claude-opus-4-7": ModelPrice(5.00, 25.00),
    "claude-opus-4-6": ModelPrice(5.00, 25.00),
    "claude-sonnet-5": ModelPrice(3.00, 15.00),
    "claude-sonnet-4-6": ModelPrice(3.00, 15.00),
    "claude-haiku-4-5": ModelPrice(1.00, 5.00),
    "claude-fable-5": ModelPrice(10.00, 50.00),
}

#: Lecture de cache ~0.1x du prix d'entree, ecriture ~1.25x.
CACHE_READ_MULTIPLIER = 0.1
CACHE_WRITE_MULTIPLIER = 1.25

_warned: set[str] = set()

#: L'API renvoie l'identifiant resolu, souvent date: `claude-haiku-4-5-20251001`.
_DATE_SUFFIX = re.compile(r"-\d{8}$")


def normalize_model(model: str) -> str:
    """Ramene un identifiant renvoye par l'API a une cle de la table de tarifs.

    Trois formes doivent tomber sur le meme tarif:
    `claude-opus-5`, `claude-opus-5-20260115` (snapshot date) et
    `us.anthropic.claude-opus-5` (prefixe fournisseur cloud). Sans cette
    normalisation, le cout est estime a zero et le budget quotidien ne
    protege plus rien.
    """
    if not model:
        return ""
    if model in PRICES:
        return model
    candidate = model.split(".")[-1]
    candidate = _DATE_SUFFIX.sub("", candidate)
    if candidate in PRICES:
        return candidate
    # Dernier recours: le prefixe connu le plus long (`claude-opus-5-preview`).
    known = [key for key in PRICES if candidate.startswith(key)]
    return max(known, key=len) if known else model


def estimate_cost_usd(model: str, usage: Usage) -> float:
    """Estime le cout d'un appel."""
    price = PRICES.get(normalize_model(model))
    if price is None:
        if model and model not in _warned:
            _warned.add(model)
            logger.warning("Tarif inconnu pour le modele %s: cout estime a 0.", model)
        return 0.0
    million = 1_000_000
    cost = usage.input_tokens / million * price.input_per_mtok
    cost += usage.output_tokens / million * price.output_per_mtok
    cost += usage.cache_read_tokens / million * price.input_per_mtok * CACHE_READ_MULTIPLIER
    cost += usage.cache_write_tokens / million * price.input_per_mtok * CACHE_WRITE_MULTIPLIER
    return round(cost, 6)
