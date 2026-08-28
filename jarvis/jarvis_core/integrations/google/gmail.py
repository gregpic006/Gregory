"""Service Gmail.

Rappel de securite qui gouverne tout ce fichier: **le contenu d'un courriel
est une donnee hostile jusqu'a preuve du contraire**. Ce service se contente de
le rapatrier et de le structurer; c'est la couche outil qui l'encapsule comme
contenu non fiable avant qu'il n'atteigne le modele.

Chemins confirmes contre le document de decouverte Gmail v1.
"""

from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass, field
from datetime import datetime
from email.message import EmailMessage
from email.utils import parseaddr, parsedate_to_datetime
from typing import Any

from jarvis_core.errors import IntegrationUnavailableError
from jarvis_core.integrations.google.client import GoogleClient

BASE = "https://gmail.googleapis.com/gmail/v1/users/me"

#: En-tetes suffisants pour lister sans rapatrier les corps.
HEADERS = ("From", "To", "Cc", "Subject", "Date", "Message-ID")

SCOPE_READ = "https://www.googleapis.com/auth/gmail.readonly"
SCOPE_WRITE = "https://www.googleapis.com/auth/gmail.compose"

#: Un rapport de caisse pese quelques dizaines de kilo-octets. Au-dela de
#: cette taille, ce n'est pas un rapport, et on refuse plutot que de charger.
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class GmailAttachment:
    """Une piece jointe, decrite sans etre telechargee.

    Le nom du fichier vient de l'expediteur: c'est du contenu non fiable. On
    ne s'en sert que pour l'affichage et pour reconnaitre une extension,
    jamais pour ecrire sur le disque a cet emplacement.
    """

    id: str
    filename: str
    mime: str
    size: int

    @property
    def looks_tabular(self) -> bool:
        """Vrai si cette piece jointe ressemble a un tableau importable."""
        name = self.filename.lower()
        return name.endswith((".csv", ".txt", ".tsv", ".xlsx", ".xlsm"))

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "filename": self.filename,
            "mime": self.mime,
            "size": self.size,
        }


@dataclass
class GmailMessage:
    """Un courriel, structure. `body` est du contenu non fiable."""

    id: str
    thread_id: str
    sender: str
    sender_email: str
    recipients: list[str]
    subject: str
    date: str
    snippet: str
    body: str = ""
    labels: list[str] = field(default_factory=list)
    unread: bool = False

    def header_line(self) -> str:
        """Resume d'en-tete, sans corps: sur, car ecrit par nous."""
        when = self.date[:16].replace("T", " ") if self.date else "date inconnue"
        marker = " [non lu]" if self.unread else ""
        return f"{self.sender} — « {self.subject or '(sans objet)'} » — {when}{marker}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "thread_id": self.thread_id,
            "from": self.sender,
            "from_email": self.sender_email,
            "subject": self.subject,
            "date": self.date,
            "unread": self.unread,
            "snippet": self.snippet,
        }


def _decode_part(data: str) -> str:
    """Decode une charge utile Gmail (base64url, remplissage parfois absent)."""
    if not data:
        return ""
    padded = data + "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace")
    except (binascii.Error, ValueError):
        return ""


def _strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = re.sub(r"(?i)<br\s*/?>|</p>", "\n", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return re.sub(r"[ \t]{2,}", " ", re.sub(r"\n{3,}", "\n\n", text)).strip()


def _extract_body(payload: dict[str, Any]) -> str:
    """Recupere le texte d'un message, en preferant `text/plain`."""
    plain: list[str] = []
    html: list[str] = []

    def walk(part: dict[str, Any]) -> None:
        mime = part.get("mimeType", "")
        body = part.get("body") or {}
        data = body.get("data", "")
        if mime == "text/plain" and data:
            plain.append(_decode_part(data))
        elif mime == "text/html" and data:
            html.append(_decode_part(data))
        for sub in part.get("parts") or []:
            walk(sub)

    walk(payload)
    if plain:
        return "\n".join(plain).strip()
    return _strip_html("\n".join(html)) if html else ""


def extract_attachments(payload: dict[str, Any]) -> list[GmailAttachment]:
    """Parcourt les parties MIME et retient celles qui portent un fichier.

    Une piece jointe se reconnait a son `attachmentId`: les parties de texte
    portent leurs octets directement, les fichiers portent une reference a
    telecharger separement.
    """
    found: list[GmailAttachment] = []

    def walk(part: dict[str, Any]) -> None:
        body = part.get("body") or {}
        attachment_id = body.get("attachmentId")
        filename = str(part.get("filename") or "")
        if attachment_id and filename:
            found.append(
                GmailAttachment(
                    id=str(attachment_id),
                    filename=filename,
                    mime=str(part.get("mimeType") or ""),
                    size=int(body.get("size") or 0),
                )
            )
        for child in part.get("parts") or []:
            walk(child)

    walk(payload)
    return found


def _headers_map(payload: dict[str, Any]) -> dict[str, str]:
    return {h.get("name", "").lower(): h.get("value", "") for h in payload.get("headers") or []}


def _to_message(raw: dict[str, Any], *, with_body: bool) -> GmailMessage:
    payload = raw.get("payload") or {}
    headers = _headers_map(payload)
    sender = headers.get("from", "")
    _, sender_email = parseaddr(sender)
    date_raw = headers.get("date", "")
    try:
        date_iso = parsedate_to_datetime(date_raw).isoformat() if date_raw else ""
    except (TypeError, ValueError):
        date_iso = date_raw
    labels = raw.get("labelIds") or []
    return GmailMessage(
        id=raw.get("id", ""),
        thread_id=raw.get("threadId", ""),
        sender=sender,
        sender_email=sender_email,
        recipients=[r.strip() for r in headers.get("to", "").split(",") if r.strip()],
        subject=headers.get("subject", ""),
        date=date_iso,
        snippet=raw.get("snippet", ""),
        body=_extract_body(payload) if with_body else "",
        labels=labels,
        unread="UNREAD" in labels,
    )


def build_query(
    *,
    query: str = "",
    sender: str = "",
    after: datetime | None = None,
    before: datetime | None = None,
    unread_only: bool = False,
) -> str:
    """Construit une requete Gmail a partir de criteres structures.

    Les dates viennent toujours de `resolve_date`, jamais du modele: c'est ce
    qui garantit que « depuis ce matin » designe le bon intervalle.
    """
    parts: list[str] = []
    if sender:
        parts.append(f"from:({sender})")
    if after:
        parts.append(f"after:{after.strftime('%Y/%m/%d')}")
    if before:
        parts.append(f"before:{(before.strftime('%Y/%m/%d'))}")
    if unread_only:
        parts.append("is:unread")
    if query:
        parts.append(query)
    return " ".join(parts).strip()


class GmailService:
    """Operations Gmail utilisees par les outils."""

    def __init__(self, client: GoogleClient) -> None:
        self.client = client

    async def search(self, query: str, *, limit: int = 10) -> list[GmailMessage]:
        """Recherche des courriels et retourne leurs en-tetes (sans les corps)."""
        self.client.require_scope(SCOPE_READ, "lire tes courriels")
        listing = await self.client.request(
            "GET",
            f"{BASE}/messages",
            params={"q": query, "maxResults": max(1, min(limit, 25))},
        )
        messages: list[GmailMessage] = []
        for item in listing.get("messages") or []:
            raw = await self.client.request(
                "GET",
                f"{BASE}/messages/{item['id']}",
                params={"format": "metadata", "metadataHeaders": list(HEADERS)},
            )
            messages.append(_to_message(raw, with_body=False))
        return messages

    async def get_message(self, message_id: str) -> GmailMessage:
        """Rapatrie un courriel complet, corps inclus (contenu non fiable)."""
        self.client.require_scope(SCOPE_READ, "lire tes courriels")
        raw = await self.client.request(
            "GET", f"{BASE}/messages/{message_id}", params={"format": "full"}
        )
        return _to_message(raw, with_body=True)

    async def list_attachments(self, message_id: str) -> list[GmailAttachment]:
        """Pieces jointes d'un courriel, sans en telecharger le contenu."""
        self.client.require_scope(SCOPE_READ, "lire tes courriels")
        raw = await self.client.request(
            "GET", f"{BASE}/messages/{message_id}", params={"format": "full"}
        )
        return extract_attachments(raw.get("payload") or {})

    async def download_attachment(
        self, message_id: str, attachment_id: str, *, max_bytes: int = MAX_ATTACHMENT_BYTES
    ) -> bytes:
        """Telecharge une piece jointe.

        Gmail rend le contenu en base64url dans du JSON, pas en binaire brut:
        on passe donc par `request`, pas par `download`.

        `max_bytes` refuse un fichier demesure. Un rapport de caisse pese
        quelques dizaines de kilo-octets; un fichier de plusieurs dizaines de
        megaoctets n'est pas un rapport, et le charger en memoire pour s'en
        apercevoir serait une faute.
        """
        self.client.require_scope(SCOPE_READ, "lire tes courriels")
        raw = await self.client.request(
            "GET", f"{BASE}/messages/{message_id}/attachments/{attachment_id}"
        )
        declared = int(raw.get("size") or 0)
        if max_bytes and declared > max_bytes:
            raise IntegrationUnavailableError(
                "Gmail", f"piece jointe trop volumineuse ({declared} octets)"
            )
        data = str(raw.get("data") or "")
        if not data:
            return b""
        content = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
        if max_bytes and len(content) > max_bytes:
            raise IntegrationUnavailableError(
                "Gmail", f"piece jointe trop volumineuse ({len(content)} octets)"
            )
        return content

    async def get_thread(self, thread_id: str, *, limit: int = 20) -> list[GmailMessage]:
        """Rapatrie un fil complet, du plus ancien au plus recent."""
        self.client.require_scope(SCOPE_READ, "lire tes courriels")
        raw = await self.client.request(
            "GET", f"{BASE}/threads/{thread_id}", params={"format": "full"}
        )
        return [_to_message(m, with_body=True) for m in (raw.get("messages") or [])[:limit]]

    async def profile_email(self) -> str:
        self.client.require_scope(SCOPE_READ, "lire tes courriels")
        profile = await self.client.request("GET", f"{BASE}/profile")
        return str(profile.get("emailAddress", ""))

    # -- ecriture ------------------------------------------------------------

    @staticmethod
    def build_raw(
        *, to: list[str], subject: str, body: str, sender: str = "", in_reply_to: str = ""
    ) -> str:
        """Compose un message RFC 5322 encode en base64url, comme attendu."""
        message = EmailMessage()
        message["To"] = ", ".join(to)
        if sender:
            message["From"] = sender
        message["Subject"] = subject
        if in_reply_to:
            message["In-Reply-To"] = in_reply_to
            message["References"] = in_reply_to
        message.set_content(body)
        return base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")

    async def create_draft(
        self,
        *,
        to: list[str],
        subject: str,
        body: str,
        thread_id: str = "",
        in_reply_to: str = "",
    ) -> dict[str, Any]:
        """Cree un brouillon. Aucun envoi: c'est une action a faible risque."""
        self.client.require_scope(SCOPE_WRITE, "preparer des brouillons")
        message: dict[str, Any] = {
            "raw": self.build_raw(to=to, subject=subject, body=body, in_reply_to=in_reply_to)
        }
        if thread_id:
            message["threadId"] = thread_id
        return await self.client.request(
            "POST", f"{BASE}/drafts", json_body={"message": message}
        )

    async def send(
        self,
        *,
        to: list[str],
        subject: str,
        body: str,
        thread_id: str = "",
        in_reply_to: str = "",
    ) -> dict[str, Any]:
        """Envoie un courriel. Palier 2: jamais appele sans confirmation."""
        self.client.require_scope(SCOPE_WRITE, "envoyer des courriels")
        message: dict[str, Any] = {
            "raw": self.build_raw(to=to, subject=subject, body=body, in_reply_to=in_reply_to)
        }
        if thread_id:
            message["threadId"] = thread_id
        return await self.client.request("POST", f"{BASE}/messages/send", json_body=message)
