"""Synchronisation Google Drive.

Deux garanties comptent ici: on n'aspire jamais le Drive entier par accident,
et un fichier illisible est nomme plutot que d'etre absent en silence.
"""

from __future__ import annotations

import docx
import pytest

from jarvis_core.documents.drive_sync import _looks_like_id, sync_drive
from jarvis_core.documents.store import DocumentStore
from jarvis_core.errors import DocumentError
from jarvis_core.integrations.google.drive import DriveFile
from jarvis_core.persistence.db import Database


class FakeDrive:
    """Drive simule: repond avec des octets, enregistre ce qui a ete demande."""

    def __init__(self, files: list[DriveFile], contents: dict[str, bytes]) -> None:
        self._files = files
        self._contents = contents
        self.listed_folders: list[str] = []
        self.fetched: list[str] = []
        self.folders = {"JARVIS": "folder_jarvis_123"}

    async def find_folder(self, name: str) -> str:
        return self.folders.get(name, "")

    async def list_files(self, *, folder_id: str = "", limit: int = 100) -> list[DriveFile]:
        self.listed_folders.append(folder_id)
        return self._files[:limit]

    async def fetch_content(self, file: DriveFile) -> bytes:
        self.fetched.append(file.id)
        if file.id not in self._contents:
            raise RuntimeError("boom")
        return self._contents[file.id]


@pytest.fixture
def store() -> DocumentStore:
    db = Database(":memory:")
    db.migrate()
    return DocumentStore(db)


def _docx_bytes(tmp_path, text: str) -> bytes:
    document = docx.Document()
    document.add_paragraph(text)
    path = tmp_path / "tmp.docx"
    document.save(str(path))
    return path.read_bytes()


NATIVE_DOC = DriveFile(
    id="f_native",
    name="Contrat Portail",
    mime_type="application/vnd.google-apps.document",
    modified_at="2026-03-01T10:00:00Z",
    url="https://docs.google.com/d/f_native",
)
TEXT_FILE = DriveFile(
    id="f_text",
    name="notes.txt",
    mime_type="text/plain",
    modified_at="2026-03-02T10:00:00Z",
    checksum="abc123",
)
IMAGE = DriveFile(id="f_img", name="photo.jpg", mime_type="image/jpeg")


async def test_sync_reads_only_the_configured_folder(store: DocumentStore) -> None:
    """La portee Drive donne acces a tout: l'indexation, elle, reste bornee."""
    drive = FakeDrive([TEXT_FILE], {"f_text": b"Le contrat se termine le 30 juin 2027."})

    await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]

    assert drive.listed_folders == ["folder_jarvis_123"]
    assert "" not in drive.listed_folders, "jamais de listing a la racine du Drive"


async def test_sync_refuses_when_no_folder_is_configured(store: DocumentStore) -> None:
    drive = FakeDrive([], {})

    with pytest.raises(DocumentError) as excinfo:
        await sync_drive(store, drive, folder="   ")  # type: ignore[arg-type]

    assert "JARVIS_DRIVE_FOLDER" in excinfo.value.user_message


async def test_unknown_folder_is_named_not_silently_empty(store: DocumentStore) -> None:
    """Un dossier introuvable doit lever: sinon « 0 document » passerait pour « rien a indexer »."""
    drive = FakeDrive([], {})

    with pytest.raises(DocumentError) as excinfo:
        await sync_drive(store, drive, folder="Dossier Absent")  # type: ignore[arg-type]

    assert "Dossier Absent" in excinfo.value.user_message


async def test_native_google_doc_is_exported_and_indexed(store: DocumentStore) -> None:
    drive = FakeDrive(
        [NATIVE_DOC],
        {"f_native": b"Le forfait mensuel est de 149 dollars par porte."},
    )

    report = await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]

    assert report.indexed == ["Contrat Portail"]
    assert store.search("forfait mensuel").hits
    document = store.list_documents()[0]
    assert document.source == "drive"
    assert document.url == "https://docs.google.com/d/f_native"


async def test_unsupported_type_is_skipped_with_a_reason(store: DocumentStore) -> None:
    drive = FakeDrive([IMAGE], {})

    report = await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]

    assert [name for name, _ in report.skipped] == ["photo.jpg"]
    assert "image/jpeg" in report.skipped[0][1]
    assert drive.fetched == [], "un fichier ignore ne doit pas etre telecharge"


async def test_a_failing_file_is_reported_and_the_others_still_index(
    store: DocumentStore,
) -> None:
    """Un echec silencieux ferait repondre « rien trouve » sur un document jamais lu."""
    drive = FakeDrive(
        [TEXT_FILE, NATIVE_DOC],
        {"f_text": b"Les reservations du samedi sont completes."},  # f_native absent -> erreur
    )

    report = await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]

    assert report.indexed == ["notes.txt"]
    assert [name for name, _ in report.failed] == ["Contrat Portail"]
    assert store.count() == 1


async def test_unchanged_file_is_not_downloaded_again(store: DocumentStore) -> None:
    drive = FakeDrive([TEXT_FILE], {"f_text": b"Un contenu stable qui ne change pas du tout."})

    first = await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]
    second = await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]

    assert first.indexed == ["notes.txt"]
    assert second.unchanged == ["notes.txt"]
    assert drive.fetched == ["f_text"], "le second passage ne doit rien retelecharger"


async def test_native_doc_uses_modified_time_since_it_has_no_checksum(
    store: DocumentStore,
) -> None:
    """Les documents Google n'ont pas de md5: la date fait foi, sinon on reindexe sans fin."""
    drive = FakeDrive([NATIVE_DOC], {"f_native": b"Contenu du contrat Portail, version une."})

    await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]
    second = await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]

    assert second.unchanged == ["Contrat Portail"]


async def test_docx_downloaded_from_drive_is_parsed(store: DocumentStore, tmp_path) -> None:
    payload = _docx_bytes(tmp_path, "La toiture doit etre refaite avant l hiver.")
    file = DriveFile(
        id="f_docx",
        name="rapport.docx",
        mime_type=(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ),
        checksum="d1",
    )
    drive = FakeDrive([file], {"f_docx": payload})

    report = await sync_drive(store, drive, folder="JARVIS")  # type: ignore[arg-type]

    assert report.indexed == ["rapport.docx"]
    assert store.search("toiture").hits


def test_folder_identifier_is_distinguished_from_a_name() -> None:
    assert _looks_like_id("1a2b3c4d5e6f7g8h9i0jKLMNOPqrstuv")
    assert not _looks_like_id("JARVIS")
    assert not _looks_like_id("Mes documents")
