"""Decoupage des documents en morceaux indexables.

Deux contraintes s'opposent.  Trop gros, un morceau noie l'information utile
dans du bruit et la recherche perd en precision.  Trop petit, il perd son
contexte: « il expire le 30 juin » ne veut rien dire sans la phrase d'avant.

On coupe donc sur les frontieres naturelles du texte — paragraphes, puis
phrases — et on laisse un recouvrement entre morceaux voisins pour qu'une
information a cheval sur une coupure reste trouvable des deux cotes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from jarvis_core.documents.extract import Segment

#: Vise en caracteres, pas en tokens: on ne depend d'aucun tokenizer et
#: l'ordre de grandeur (~250 mots) convient aux modeles d'embedding courants.
TARGET_CHARS = 1100
#: En dessous, on fusionne avec le morceau suivant plutot que d'indexer une
#: miette sans contexte.
MIN_CHARS = 220
#: Recouvrement entre deux morceaux consecutifs.
OVERLAP_CHARS = 160

_PARAGRAPH = re.compile(r"\n\s*\n")
_SENTENCE = re.compile(r"(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ«\"'])")
_WHITESPACE = re.compile(r"[ \t]+")


@dataclass(frozen=True)
class Chunk:
    """Un morceau indexable, qui sait d'ou il vient."""

    text: str
    locator: str
    index: int


def normalize(text: str) -> str:
    """Nettoie sans denaturer: les retours de ligne portent du sens."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(" ", " ")
    text = _WHITESPACE.sub(" ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def chunk_segments(segments: list[Segment]) -> list[Chunk]:
    """Transforme des segments extraits en morceaux indexables."""
    chunks: list[Chunk] = []
    for segment in segments:
        text = normalize(segment.text)
        if not text:
            continue
        for piece in _split(text):
            chunks.append(Chunk(text=piece, locator=segment.locator, index=len(chunks)))
    return _merge_runts(chunks)


def _split(text: str) -> list[str]:
    """Coupe un texte en morceaux d'environ TARGET_CHARS, sur des frontieres."""
    if len(text) <= TARGET_CHARS:
        return [text]

    units = [p.strip() for p in _PARAGRAPH.split(text) if p.strip()]
    # Un paragraphe seul plus long que la cible doit etre coupe en phrases.
    expanded: list[str] = []
    for unit in units:
        if len(unit) <= TARGET_CHARS:
            expanded.append(unit)
        else:
            expanded.extend(_split_sentences(unit))

    pieces: list[str] = []
    current = ""
    for unit in expanded:
        if not current:
            current = unit
        elif len(current) + len(unit) + 2 <= TARGET_CHARS:
            current = f"{current}\n\n{unit}"
        else:
            pieces.append(current)
            current = _tail(current) + unit if OVERLAP_CHARS else unit
    if current:
        pieces.append(current)
    return pieces


def _split_sentences(paragraph: str) -> list[str]:
    """Coupe un paragraphe trop long, en phrases puis, en dernier ressort, net."""
    sentences = _SENTENCE.split(paragraph)
    pieces: list[str] = []
    current = ""
    for sentence in sentences:
        if len(sentence) > TARGET_CHARS:
            # Une « phrase » demesuree: tableau colle, texte sans ponctuation.
            if current:
                pieces.append(current)
                current = ""
            pieces.extend(
                sentence[i : i + TARGET_CHARS] for i in range(0, len(sentence), TARGET_CHARS)
            )
            continue
        if not current:
            current = sentence
        elif len(current) + len(sentence) + 1 <= TARGET_CHARS:
            current = f"{current} {sentence}"
        else:
            pieces.append(current)
            current = sentence
    if current:
        pieces.append(current)
    return pieces


def _tail(text: str) -> str:
    """Fin du morceau precedent, pour le recouvrement."""
    tail = text[-OVERLAP_CHARS:]
    # Repartir d'un debut de phrase quand c'est possible, sinon d'un mot.
    match = _SENTENCE.search(tail)
    if match:
        tail = tail[match.end() :]
    elif " " in tail:
        tail = tail.split(" ", 1)[1]
    return f"{tail.strip()} " if tail.strip() else ""


def _merge_runts(chunks: list[Chunk]) -> list[Chunk]:
    """Recolle les morceaux trop courts a leur voisin de meme provenance."""
    if len(chunks) < 2:
        return chunks
    merged: list[Chunk] = []
    for chunk in chunks:
        if (
            merged
            and len(chunk.text) < MIN_CHARS
            and merged[-1].locator == chunk.locator
            and len(merged[-1].text) + len(chunk.text) <= TARGET_CHARS + MIN_CHARS
        ):
            previous = merged.pop()
            merged.append(
                Chunk(
                    text=f"{previous.text}\n\n{chunk.text}",
                    locator=previous.locator,
                    index=previous.index,
                )
            )
            continue
        merged.append(Chunk(text=chunk.text, locator=chunk.locator, index=len(merged)))
    return merged
