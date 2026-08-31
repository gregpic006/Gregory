"""Ecrire sur le Drive a la voix.

La propriete la plus importante de ce module est une **portee**: `drive.file`
ne donne acces qu'aux fichiers crees par JARVIS. Dire « ajoute une note sur mon
Drive » ne doit jamais ouvrir le droit de modifier ou supprimer le reste.
"""

from __future__ import annotations

from typing import Any

import pytest

from jarvis_core.integrations.google.drive import (
    DOCUMENT_MIME,
    FOLDER_MIME,
    SCOPE_DRIVE_READ,
    SCOPE_DRIVE_WRITE,
    DriveService,
)
from jarvis_core.integrations.google.oauth import SCOPES_DRIVE, scopes_for

# ------------------------------------------------------------- les portees


def test_writing_asks_for_the_narrow_scope_not_full_drive() -> None:
    """`drive.file` plutot que `drive`: c'est toute la difference.

    `drive` donnerait a JARVIS le droit de modifier et supprimer n'importe quel
    fichier du Drive. `drive.file` le limite a ce qu'il a lui-meme cree.
    """
    scopes = scopes_for(
        gmail=False, gmail_write=False, calendar=False, contacts=False, drive_write=True
    )

    assert SCOPE_DRIVE_WRITE in scopes
    assert "https://www.googleapis.com/auth/drive" not in scopes
    assert SCOPE_DRIVE_READ not in scopes


def test_reading_and_writing_are_independent() -> None:
    """On peut vouloir creer des notes sans ouvrir la lecture de tout le Drive."""
    read_only = scopes_for(
        gmail=False, gmail_write=False, calendar=False, contacts=False, drive=True
    )
    write_only = scopes_for(
        gmail=False, gmail_write=False, calendar=False, contacts=False, drive_write=True
    )

    assert SCOPES_DRIVE[0] in read_only and SCOPE_DRIVE_WRITE not in read_only
    assert SCOPE_DRIVE_WRITE in write_only and SCOPES_DRIVE[0] not in write_only


def test_no_drive_scope_is_asked_when_nothing_is_enabled() -> None:
    """Moindre privilege: une portee non demandee n'apparait pas au consentement."""
    scopes = scopes_for(gmail=True, gmail_write=True, calendar=True, contacts=True)

    assert not any("drive" in scope for scope in scopes)


# ------------------------------------------------------------- le client


class FakeClient:
    """Client Google minimal: retient les appels au lieu de les emettre."""

    def __init__(self) -> None:
        self.scopes_required: list[str] = []
        self.requests: list[dict[str, Any]] = []
        self.uploads: list[dict[str, Any]] = []

    def require_scope(self, scope: str, _why: str) -> None:
        self.scopes_required.append(scope)

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.requests.append({"method": method, "url": url, "body": json_body})
        return {
            "id": "file-1",
            "name": (json_body or {}).get("name", "Note"),
            "mimeType": (json_body or {}).get("mimeType", DOCUMENT_MIME),
            "modifiedTime": "2026-08-28T12:00:00Z",
            "webViewLink": "https://drive.google.com/file-1",
        }

    async def upload(
        self,
        url: str,
        content: bytes,
        *,
        content_type: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.uploads.append({"url": url, "content": content, "type": content_type})
        return {"id": "file-1"}


@pytest.mark.asyncio
async def test_creating_a_note_requires_the_write_scope() -> None:
    client = FakeClient()

    await DriveService(client).create_document("Idees", "Contenu")  # type: ignore[arg-type]

    assert SCOPE_DRIVE_WRITE in client.scopes_required


@pytest.mark.asyncio
async def test_a_note_becomes_a_google_doc_not_an_inert_file() -> None:
    """« Ajoute une note sur mon Drive » veut dire un document modifiable."""
    client = FakeClient()

    await DriveService(client).create_document("Idees", "Contenu")  # type: ignore[arg-type]

    assert client.requests[0]["body"]["mimeType"] == DOCUMENT_MIME


@pytest.mark.asyncio
async def test_the_content_is_sent_as_utf8() -> None:
    """Les accents ne doivent pas se perdre entre la voix et le document."""
    client = FakeClient()

    await DriveService(client).create_document("Note", "Reunion prevue a Montreal")  # type: ignore[arg-type]

    assert client.uploads[0]["content"] == b"Reunion prevue a Montreal"
    assert "utf-8" in client.uploads[0]["type"].lower()


@pytest.mark.asyncio
async def test_an_empty_note_costs_no_upload() -> None:
    """Deposer du vide serait un aller-retour reseau pour rien."""
    client = FakeClient()

    await DriveService(client).create_document("Vide", "   ")  # type: ignore[arg-type]

    assert client.uploads == []


@pytest.mark.asyncio
async def test_a_folder_is_created_with_the_folder_type() -> None:
    client = FakeClient()

    await DriveService(client).create_folder("Baux 2026")  # type: ignore[arg-type]

    assert client.requests[0]["body"]["mimeType"] == FOLDER_MIME


@pytest.mark.asyncio
async def test_a_destination_folder_is_passed_as_parent() -> None:
    client = FakeClient()

    await DriveService(client).create_document(  # type: ignore[arg-type]
        "Note", "x", parent_id="dossier-9"
    )

    assert client.requests[0]["body"]["parents"] == ["dossier-9"]


# --------------------------------------------------------------- les outils


def test_the_drive_tools_are_gated_behind_their_own_flag() -> None:
    """L'ecriture Drive ne doit pas s'activer avec la lecture."""
    from jarvis_core.tools.google import registry

    tools = {tool.name: tool for tool in registry.all()}

    for name in ("create_drive_note", "create_drive_folder"):
        assert tools[name].feature_flag == "drive_write", name


def test_the_flag_exists_and_is_off_by_default() -> None:
    """Une capacite d'ecriture ne s'active jamais toute seule."""
    from jarvis_core.config import Settings

    assert Settings().feature_drive_write is False
    assert Settings().feature_map()["drive_write"] is False
