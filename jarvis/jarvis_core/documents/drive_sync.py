"""Synchronisation des documents Google Drive vers l'index local.

Trois regles gouvernent ce module.

**On ne lit qu'un dossier.**  La portee Drive donne acces a tout; l'indexation
se limite au dossier configure.  C'est une restriction volontaire, pas une
limite technique.

**On ne reindexe pas ce qui n'a pas change.**  Drive fournit une empreinte
(`md5Checksum`) pour les fichiers binaires; pour les documents natifs, qui n'en
ont pas, on retombe sur la date de modification.

**Un fichier en echec ne fait pas echouer la synchronisation.**  Il est nomme
dans le rapport.  Un document illisible silencieusement absent de l'index
serait pire qu'une erreur visible: JARVIS repondrait « je n'ai rien trouve »
sur un contrat qu'il n'a simplement jamais lu.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

from jarvis_core.documents.extract import Segment, extract
from jarvis_core.documents.ingest import IngestReport, content_hash, ingest_segments
from jarvis_core.documents.store import DocumentStore
from jarvis_core.errors import DocumentError, IntegrationNotConfiguredError
from jarvis_core.integrations.google.drive import DriveFile, DriveService

logger = logging.getLogger(__name__)


async def sync_drive(
    store: DocumentStore,
    drive: DriveService,
    *,
    folder: str,
    limit: int = 100,
    force: bool = False,
    org_id: str = "PERSONAL",
) -> IngestReport:
    """Indexe les documents d'un dossier Drive.

    Args:
        folder: nom ou identifiant du dossier. Obligatoire: on refuse
            d'indexer la racine du Drive.

    Raises:
        DocumentError: dossier non configure ou introuvable.
    """
    report = IngestReport()
    if not folder.strip():
        raise DocumentError(
            "dossier Drive non configure",
            user_message=(
                "Aucun dossier Drive n'est configure. "
                "Renseigne JARVIS_DRIVE_FOLDER dans le fichier .env — "
                "je n'indexe jamais l'ensemble de ton Drive."
            ),
        )

    folder_id = folder if _looks_like_id(folder) else await drive.find_folder(folder)
    if not folder_id:
        raise DocumentError(
            f"dossier Drive introuvable: {folder}",
            user_message=(
                f"Je ne trouve aucun dossier « {folder} » dans ton Drive. "
                "Verifie le nom, ou mets son identifiant dans JARVIS_DRIVE_FOLDER."
            ),
        )

    files = await drive.list_files(folder_id=folder_id, limit=limit)
    for file in files:
        if not file.readable:
            report.skipped.append((file.name, f"format non gere ({file.mime_type})"))
            continue
        try:
            state, chunks = await _sync_one(store, drive, file, force=force, org_id=org_id)
        except (DocumentError, IntegrationNotConfiguredError) as exc:
            logger.warning("drive: %s non indexe: %s", file.name, exc)
            report.failed.append((file.name, exc.user_message))
            continue
        except Exception as exc:  # noqa: BLE001 - un fichier ne doit pas tout arreter
            logger.warning("drive: %s non indexe: %s", file.name, exc)
            report.failed.append((file.name, "erreur inattendue pendant la lecture"))
            continue

        if state == "indexed":
            report.indexed.append(file.name)
            report.add_chunks(chunks)
        else:
            report.unchanged.append(file.name)
    return report


async def _sync_one(
    store: DocumentStore,
    drive: DriveService,
    file: DriveFile,
    *,
    force: bool,
    org_id: str,
) -> tuple[str, int]:
    # Les documents Google natifs n'ont pas de md5: la date fait foi.
    fingerprint = file.checksum or file.modified_at
    existing = store.find_by_identity(source="drive", external_id=file.id)
    if existing and not force and fingerprint and existing.content_hash == fingerprint:
        return "unchanged", existing.chunk_count

    raw = await drive.fetch_content(file)
    if not raw:
        raise DocumentError(
            f"contenu vide: {file.name}",
            user_message=f"« {file.name} » est vide.",
        )

    segments = _extract_bytes(raw, suffix=file.suffix, name=file.name)
    chunks = ingest_segments(
        store,
        title=file.name,
        segments=segments,
        source="drive",
        content_hash_value=fingerprint or content_hash(raw),
        external_id=file.id,
        url=file.url,
        mime=file.mime_type,
        org_id=org_id,
        modified_at=file.modified_at,
    )
    return "indexed", chunks


def _extract_bytes(raw: bytes, *, suffix: str, name: str) -> list[Segment]:
    """Ecrit le contenu dans un fichier temporaire pour reutiliser les extracteurs.

    pypdf et python-docx veulent un fichier; passer par le disque evite de
    dupliquer toute la gestion d'erreurs de `extract`.
    """
    if not suffix:
        raise DocumentError(
            f"type non gere pour {name}",
            user_message=f"Je ne sais pas lire « {name} ».",
        )
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(raw)
            tmp_path = Path(handle.name)
        return extract(tmp_path)
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def _looks_like_id(value: str) -> bool:
    """Un identifiant Drive est long et sans espace; un nom de dossier, non."""
    return len(value) > 24 and " " not in value and "/" not in value
