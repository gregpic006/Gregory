"""Extraction, decoupage et indexation des documents.

Ce qui est verrouille ici, ce n'est pas seulement que « ca marche »: c'est que
JARVIS ne peut pas presenter un echec de lecture comme une absence
d'information.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from jarvis_core.documents.chunk import MIN_CHARS, TARGET_CHARS, chunk_segments, normalize
from jarvis_core.documents.extract import Segment, extract, is_supported
from jarvis_core.documents.ingest import ingest_directory, ingest_file
from jarvis_core.documents.store import DocumentStore
from jarvis_core.errors import DocumentError
from jarvis_core.persistence.db import Database


@pytest.fixture
def store() -> DocumentStore:
    db = Database(":memory:")
    db.migrate()
    return DocumentStore(db)


# --------------------------------------------------------------------- extraction


def test_markdown_headings_become_locators(tmp_path: Path) -> None:
    """Une citation doit pouvoir dire ou regarder, pas seulement quel fichier."""
    file = tmp_path / "bail.md"
    file.write_text("# Bail\n\n## Loyer\nLe loyer est de 4200 $.\n\n## Resiliation\nSix mois.\n")

    segments = extract(file)

    locators = [s.locator for s in segments]
    assert "Loyer" in locators
    assert "Resiliation" in locators


def test_unsupported_format_is_refused_by_name(tmp_path: Path) -> None:
    """Lire un .xlsx comme du texte produirait du charabia indexe comme du sens."""
    file = tmp_path / "ventes.xlsx"
    file.write_bytes(b"PK\x03\x04binaire")

    assert not is_supported(file)
    with pytest.raises(DocumentError) as excinfo:
        extract(file)
    assert ".xlsx" in str(excinfo.value)
    assert "geres" in excinfo.value.user_message


def test_missing_file_says_so(tmp_path: Path) -> None:
    with pytest.raises(DocumentError) as excinfo:
        extract(tmp_path / "absent.md")
    assert "trouve pas" in excinfo.value.user_message


def test_document_without_text_is_an_error_not_an_empty_result(tmp_path: Path) -> None:
    """Un PDF scanne sans texte doit lever, pas produire un document vide.

    Un document indexe a vide repondrait « rien trouve » a toute question,
    laissant croire que son contenu a ete lu.
    """
    file = tmp_path / "vide.txt"
    file.write_text("   \n\n  ")

    with pytest.raises(DocumentError) as excinfo:
        extract(file)
    assert "aucun texte" in str(excinfo.value).lower()


# ---------------------------------------------------------------------- decoupage


def test_long_text_is_split_with_overlap() -> None:
    """Le recouvrement evite qu'une phrase a cheval devienne introuvable."""
    # Chaque phrase porte un numero unique: on peut donc verifier lesquelles
    # se retrouvent des deux cotes d'une coupure.
    text = " ".join(f"La clause {i} traite d un sujet distinct et precis." for i in range(200))

    chunks = chunk_segments([Segment(text=text, locator="page 1")])

    assert len(chunks) > 1
    assert all(c.locator == "page 1" for c in chunks)

    first_clauses = {int(n) for n in re.findall(r"clause (\d+)", chunks[0].text)}
    second_clauses = {int(n) for n in re.findall(r"clause (\d+)", chunks[1].text)}
    assert first_clauses & second_clauses, "aucun recouvrement entre deux morceaux voisins"


def test_short_segments_are_merged_not_indexed_alone() -> None:
    """« Il expire le 30 juin » sans contexte n'est pas une reponse."""
    segments = [Segment(text="Court un.", locator="p"), Segment(text="Court deux.", locator="p")]

    chunks = chunk_segments(segments)

    assert len(chunks) == 1
    assert "Court un." in chunks[0].text and "Court deux." in chunks[0].text


def test_chunks_stay_near_the_target_size() -> None:
    text = "\n\n".join(f"Paragraphe {i}. " + "mot " * 80 for i in range(20))

    chunks = chunk_segments([Segment(text=text)])

    assert chunks
    # Le recouvrement peut deborder un peu, jamais du simple au double.
    assert max(len(c.text) for c in chunks) < TARGET_CHARS * 2
    assert all(len(c.text) >= MIN_CHARS for c in chunks[:-1])


def test_normalize_preserves_paragraph_breaks() -> None:
    assert normalize("un\n\n\n\ndeux   trois") == "un\n\ndeux trois"


# --------------------------------------------------------------------- indexation


def test_reindexing_unchanged_file_is_a_no_op(tmp_path: Path, store: DocumentStore) -> None:
    file = tmp_path / "notes.txt"
    file.write_text("Les reservations du samedi atteignent 40 couverts.")

    first, _ = ingest_file(store, file)
    second, _ = ingest_file(store, file)

    assert first == "indexed"
    assert second == "unchanged"
    assert store.count() == 1


def test_modified_file_replaces_the_previous_version(tmp_path: Path, store: DocumentStore) -> None:
    """Sans remplacement, une recherche renverrait l'ancienne version comme actuelle."""
    file = tmp_path / "bail.md"
    file.write_text("Le loyer est de 4200 dollars par mois.")
    ingest_file(store, file)

    file.write_text("Le loyer est de 4500 dollars par mois.")
    ingest_file(store, file)

    assert store.count() == 1
    assert "4500" in store.full_text(store.list_documents()[0].id)
    assert not store.search("4200").hits


def test_directory_report_names_every_skipped_file(tmp_path: Path, store: DocumentStore) -> None:
    """Un fichier saute en silence ferait croire que son contenu est indexe."""
    (tmp_path / "ok.md").write_text("Contenu utile du contrat de location.")
    (tmp_path / "image.png").write_bytes(b"\x89PNG binaire")

    report = ingest_directory(store, tmp_path)

    assert report.indexed == ["ok.md"]
    assert [name for name, _ in report.skipped] == ["image.png"]
    assert "format non gere" in report.skipped[0][1]


def test_unreadable_file_is_reported_not_swallowed(tmp_path: Path, store: DocumentStore) -> None:
    (tmp_path / "bon.md").write_text("Un contenu parfaitement lisible et assez long.")
    (tmp_path / "casse.pdf").write_bytes(b"pas du tout un pdf")

    report = ingest_directory(store, tmp_path)

    assert report.indexed == ["bon.md"]
    assert [name for name, _ in report.failed] == ["casse.pdf"]


def test_missing_directory_explains_how_to_fix_it(store: DocumentStore) -> None:
    with pytest.raises(DocumentError) as excinfo:
        ingest_directory(store, "/dossier/qui/n/existe/pas")
    assert "JARVIS_DOCUMENTS_DIR" in excinfo.value.user_message
