"""Service Google Drive (lecture seule).

Chemins et champs confirmes contre le document de decouverte Drive v3
(revision 20260819).

Deux precautions structurent ce module.

La portee `drive.readonly` donne acces a **tout** le Drive.  On la compense en
restreignant l'indexation a un dossier declare (`JARVIS_DRIVE_FOLDER`): meme si
le jeton permet davantage, JARVIS ne lit que ce dossier.  Le moindre privilege
ne s'arrete pas a l'ecran de consentement.

Les documents Google natifs (Docs, Sheets) n'ont pas de contenu telechargeable
tel quel: il faut les exporter.  On les exporte en texte brut, ce qui suffit a
la recherche et evite de manipuler des binaires volumineux.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from jarvis_core.integrations.google.client import GoogleClient

logger = logging.getLogger(__name__)

BASE = "https://www.googleapis.com/drive/v3"
SCOPE_DRIVE_READ = "https://www.googleapis.com/auth/drive.readonly"

#: Documents Google natifs -> format d'export demande.
EXPORT_FORMATS = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
}

#: Types binaires qu'on sait lire apres telechargement.
BINARY_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "text/plain": ".txt",
    "text/markdown": ".md",
}

#: Un fichier au-dela n'est pas telecharge: il ferait exploser la memoire pour
#: un benefice nul en recherche.
MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

FIELDS = "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,md5Checksum)"


@dataclass
class DriveFile:
    """Un fichier Drive, tel qu'on en a besoin pour l'indexation."""

    id: str
    name: str
    mime_type: str
    modified_at: str = ""
    size: int = 0
    url: str = ""
    checksum: str = ""

    @property
    def is_native(self) -> bool:
        """Document Google (Docs, Sheets, Slides): necessite un export."""
        return self.mime_type in EXPORT_FORMATS

    @property
    def readable(self) -> bool:
        return self.is_native or self.mime_type in BINARY_TYPES

    @property
    def suffix(self) -> str:
        """Extension a utiliser pour choisir l'extracteur."""
        if self.is_native:
            return ".txt" if EXPORT_FORMATS[self.mime_type] == "text/plain" else ".txt"
        return BINARY_TYPES.get(self.mime_type, "")

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "mime_type": self.mime_type,
            "modified_at": self.modified_at,
            "size": self.size,
            "url": self.url,
        }


def _to_file(payload: dict[str, Any]) -> DriveFile:
    raw_size = payload.get("size") or "0"
    try:
        size = int(raw_size)
    except (TypeError, ValueError):
        size = 0
    return DriveFile(
        id=str(payload.get("id", "")),
        name=str(payload.get("name", "")) or "(sans nom)",
        mime_type=str(payload.get("mimeType", "")),
        modified_at=str(payload.get("modifiedTime", "")),
        size=size,
        url=str(payload.get("webViewLink", "")),
        checksum=str(payload.get("md5Checksum", "")),
    )


class DriveService:
    """Lecture de Google Drive, restreinte a un dossier."""

    def __init__(self, client: GoogleClient) -> None:
        self.client = client

    async def list_files(
        self, *, folder_id: str = "", limit: int = 100
    ) -> list[DriveFile]:
        """Liste les fichiers lisibles, dans un dossier si precise.

        Args:
            folder_id: identifiant du dossier. Vide = tout le Drive accessible;
                l'appelant est responsable de ne pas le faire sans raison.
        """
        self.client.require_scope(SCOPE_DRIVE_READ, "lire tes documents Drive")

        clauses = ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'"]
        if folder_id:
            clauses.append(f"'{folder_id}' in parents")

        files: list[DriveFile] = []
        page_token = ""
        while len(files) < limit:
            params: dict[str, Any] = {
                "q": " and ".join(clauses),
                "fields": FIELDS,
                "pageSize": min(100, limit - len(files)),
                "orderBy": "modifiedTime desc",
                "supportsAllDrives": "true",
                "includeItemsFromAllDrives": "true",
            }
            if page_token:
                params["pageToken"] = page_token
            payload = await self.client.request("GET", f"{BASE}/files", params=params)
            batch = [_to_file(item) for item in payload.get("files") or []]
            files.extend(batch)
            page_token = str(payload.get("nextPageToken") or "")
            if not page_token or not batch:
                break
        return files[:limit]

    async def find_folder(self, name: str) -> str:
        """Identifiant du premier dossier portant ce nom, ou chaine vide.

        Un nom peut correspondre a plusieurs dossiers: on ne devine pas, on
        prend le plus recemment modifie et l'appelant peut preferer un ID.
        """
        self.client.require_scope(SCOPE_DRIVE_READ, "lire tes documents Drive")
        escaped = name.replace("'", "\\'")
        payload = await self.client.request(
            "GET",
            f"{BASE}/files",
            params={
                "q": (
                    "mimeType = 'application/vnd.google-apps.folder' "
                    f"and name = '{escaped}' and trashed = false"
                ),
                "fields": "files(id,name,modifiedTime)",
                "orderBy": "modifiedTime desc",
                "pageSize": 10,
            },
        )
        found = payload.get("files") or []
        return str(found[0]["id"]) if found else ""

    async def fetch_content(self, file: DriveFile) -> bytes:
        """Recupere le contenu d'un fichier, exporte si c'est un document Google."""
        self.client.require_scope(SCOPE_DRIVE_READ, "lire tes documents Drive")
        if file.is_native:
            return await self.client.download(
                f"{BASE}/files/{file.id}/export",
                params={"mimeType": EXPORT_FORMATS[file.mime_type]},
                max_bytes=MAX_DOWNLOAD_BYTES,
            )
        return await self.client.download(
            f"{BASE}/files/{file.id}",
            params={"alt": "media", "supportsAllDrives": "true"},
            max_bytes=MAX_DOWNLOAD_BYTES,
        )
