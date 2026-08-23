"""Tests d'analyse des reponses Gmail, Calendar et Contacts.

Ces services transforment du JSON Google en objets exploitables. Les pieges
reels sont ici: encodage base64url sans remplissage, corps multipart, evenements
sur la journee entiere, series recurrentes, contacts homonymes.
"""

from __future__ import annotations

import base64
from datetime import datetime
from email import message_from_bytes
from email.policy import default as default_policy
from typing import Any

import httpx
import pytest

from jarvis_core.integrations.google.calendar import CalendarService, _to_event
from jarvis_core.integrations.google.client import PROVIDER, GoogleClient
from jarvis_core.integrations.google.contacts import ContactsService
from jarvis_core.integrations.google.gmail import GmailService, _to_message, build_query
from jarvis_core.integrations.google.oauth import GoogleOAuth
from jarvis_core.integrations.google.tokens import OAuthTokenRepository
from jarvis_core.persistence.db import Database
from jarvis_core.security.crypto import SecretBox

TZ = "America/Montreal"


def _b64(text: str) -> str:
    """Encode comme Gmail: base64url, remplissage retire."""
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def _client(db: Database, handler: Any, scopes: list[str]) -> GoogleClient:
    from datetime import UTC, timedelta

    tokens = OAuthTokenRepository(db, SecretBox(SecretBox.generate_key()))
    tokens.save(
        provider=PROVIDER, account="greg@example.com", access_token="at",
        refresh_token="rt", token_type="Bearer", scopes=scopes,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    oauth = GoogleOAuth(client_id="c", client_secret="s", redirect_uri="http://x", client=http)
    return GoogleClient(oauth=oauth, tokens=tokens, http=http)


# =============================================================================
# Gmail
# =============================================================================


def test_message_headers_are_parsed() -> None:
    message = _to_message(
        {
            "id": "m1",
            "threadId": "t1",
            "snippet": "Bonjour Greg",
            "labelIds": ["INBOX", "UNREAD"],
            "payload": {
                "headers": [
                    {"name": "From", "value": "Me Tremblay <avocat@example.com>"},
                    {"name": "Subject", "value": "Incorporation de Portail"},
                    {"name": "Date", "value": "Fri, 14 Aug 2026 09:12:00 -0400"},
                    {"name": "To", "value": "greg@example.com"},
                ]
            },
        },
        with_body=False,
    )
    assert message.sender_email == "avocat@example.com"
    assert message.subject == "Incorporation de Portail"
    assert message.unread is True
    assert message.date.startswith("2026-08-14T09:12")


def test_plain_text_is_preferred_over_html() -> None:
    message = _to_message(
        {
            "id": "m2",
            "payload": {
                "mimeType": "multipart/alternative",
                "headers": [],
                "parts": [
                    {"mimeType": "text/plain", "body": {"data": _b64("Version texte")}},
                    {"mimeType": "text/html", "body": {"data": _b64("<p>Version HTML</p>")}},
                ],
            },
        },
        with_body=True,
    )
    assert message.body == "Version texte"


def test_html_only_message_is_stripped_readable() -> None:
    html = "<html><style>p{color:red}</style><body><p>Le taux est 3,8 %</p></body></html>"
    message = _to_message(
        {"id": "m3", "payload": {"mimeType": "text/html", "body": {"data": _b64(html)}}},
        with_body=True,
    )
    assert "3,8 %" in message.body
    assert "<" not in message.body
    assert "color:red" not in message.body


def test_nested_multipart_body_is_found() -> None:
    """Un corps enfoui sous une piece jointe doit quand meme etre extrait."""
    message = _to_message(
        {
            "id": "m4",
            "payload": {
                "mimeType": "multipart/mixed",
                "parts": [
                    {
                        "mimeType": "multipart/alternative",
                        "parts": [
                            {"mimeType": "text/plain", "body": {"data": _b64("Contenu profond")}}
                        ],
                    },
                    {"mimeType": "application/pdf", "body": {"attachmentId": "a1"}},
                ],
            },
        },
        with_body=True,
    )
    assert message.body == "Contenu profond"


def test_undecodable_payload_yields_empty_body_not_a_crash() -> None:
    message = _to_message(
        {"id": "m5", "payload": {"mimeType": "text/plain", "body": {"data": "!!!pas-du-base64"}}},
        with_body=True,
    )
    assert message.body == ""


def test_query_builder_uses_real_dates() -> None:
    query = build_query(
        sender="Marc",
        after=datetime(2026, 8, 23, 6, 0),
        before=datetime(2026, 8, 24, 6, 0),
        unread_only=True,
        query="facture",
    )
    assert "from:(Marc)" in query
    assert "after:2026/08/23" in query
    assert "before:2026/08/24" in query
    assert "is:unread" in query
    assert "facture" in query


def test_outgoing_message_is_valid_rfc5322() -> None:
    raw = GmailService.build_raw(
        to=["xavier@example.com", "eliot@example.com"],
        subject="Report",
        body="On reporte a demain.",
        in_reply_to="<abc@mail.gmail.com>",
    )
    decoded = message_from_bytes(
        base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)), policy=default_policy
    )
    assert decoded["To"] == "xavier@example.com, eliot@example.com"
    assert decoded["Subject"] == "Report"
    assert decoded["In-Reply-To"] == "<abc@mail.gmail.com>"
    assert "On reporte a demain." in decoded.get_content()


def test_accented_subject_survives_encoding() -> None:
    raw = GmailService.build_raw(to=["a@b.c"], subject="Réunion à 15 h", body="Été")
    decoded = message_from_bytes(
        base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)), policy=default_policy
    )
    assert decoded["Subject"] == "Réunion à 15 h"
    assert "Été" in decoded.get_content()


async def test_search_requests_only_metadata(db: Database) -> None:
    """Lister ne doit pas rapatrier les corps: moins de donnees, moins de risque."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [{"id": "m1"}]})
        return httpx.Response(
            200,
            json={
                "id": "m1", "threadId": "t1", "snippet": "s",
                "payload": {"headers": [{"name": "From", "value": "a@b.c"}]},
            },
        )

    service = GmailService(
        _client(db, handler, ["https://www.googleapis.com/auth/gmail.readonly"])
    )
    messages = await service.search("in:inbox", limit=5)

    assert len(messages) == 1
    assert messages[0].body == ""
    assert "format=metadata" in str(seen[1].url)


async def test_reading_without_the_scope_is_refused(db: Database) -> None:
    service = GmailService(_client(db, lambda r: httpx.Response(200, json={}), ["openid"]))
    from jarvis_core.errors import IntegrationNotConfiguredError

    with pytest.raises(IntegrationNotConfiguredError):
        await service.search("in:inbox")


# =============================================================================
# Calendar
# =============================================================================


def test_timed_event_is_parsed() -> None:
    event = _to_event(
        {
            "id": "e1",
            "summary": "Rencontre notaire",
            "start": {"dateTime": "2026-08-24T14:00:00-04:00"},
            "end": {"dateTime": "2026-08-24T15:00:00-04:00"},
            "location": "Quebec",
            "attendees": [
                {"email": "notaire@example.com"},
                {"email": "greg@example.com", "self": True},
            ],
        }
    )
    assert event.all_day is False
    assert event.attendees == ["notaire@example.com"], "l'utilisateur n'est pas un invite"
    assert "14 h" in event.spoken_line(TZ)


def test_all_day_event_is_recognized() -> None:
    event = _to_event(
        {"id": "e2", "summary": "Vacances", "start": {"date": "2026-09-01"},
         "end": {"date": "2026-09-08"}}
    )
    assert event.all_day is True
    assert "toute la journee" in event.spoken_line(TZ)


async def test_recurring_series_are_expanded_and_cancelled_ones_dropped(db: Database) -> None:
    """`singleEvents=true` est indispensable, sinon les recurrents disparaissent."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "items": [
                    {"id": "a", "summary": "Vivant",
                     "start": {"dateTime": "2026-08-24T09:00:00-04:00"},
                     "end": {"dateTime": "2026-08-24T10:00:00-04:00"}},
                    {"id": "b", "summary": "Annule", "status": "cancelled",
                     "start": {"dateTime": "2026-08-24T11:00:00-04:00"},
                     "end": {"dateTime": "2026-08-24T12:00:00-04:00"}},
                ]
            },
        )

    service = CalendarService(
        _client(db, handler, ["https://www.googleapis.com/auth/calendar.events"])
    )
    events = await service.list_events(
        start="2026-08-24T00:00:00-04:00", end="2026-08-25T00:00:00-04:00"
    )
    assert [e.id for e in events] == ["a"]
    query = str(seen[0].url)
    assert "singleEvents=true" in query
    assert "orderBy=startTime" in query


# =============================================================================
# Contacts
# =============================================================================


def _people(names: list[tuple[str, str]]) -> dict[str, Any]:
    return {
        "results": [
            {
                "person": {
                    "names": [{"displayName": name}],
                    "emailAddresses": [{"value": email}],
                }
            }
            for name, email in names
        ]
    }


async def test_single_match_resolves_without_asking(db: Database) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if not request.url.params.get("query"):
            return httpx.Response(200, json={})  # amorcage
        return httpx.Response(200, json=_people([("Xavier Roy", "xavier@portail.example")]))

    service = ContactsService(
        _client(db, handler, ["https://www.googleapis.com/auth/contacts.readonly"])
    )
    candidates, _ = await service.resolve_recipient("Xavier")
    assert len(candidates) == 1
    assert candidates[0].primary_email == "xavier@portail.example"


async def test_several_matches_force_a_question(db: Database) -> None:
    """Trois Marc: on ne choisit pas a la place de l'utilisateur."""

    def handler(request: httpx.Request) -> httpx.Response:
        if not request.url.params.get("query"):
            return httpx.Response(200, json={})
        return httpx.Response(
            200,
            json=_people(
                [("Marc Tremblay", "mt@a.com"), ("Marc Gagnon", "mg@b.com"),
                 ("Marc Roy", "mr@c.com")]
            ),
        )

    service = ContactsService(
        _client(db, handler, ["https://www.googleapis.com/auth/contacts.readonly"])
    )
    candidates, reason = await service.resolve_recipient("Marc")
    assert len(candidates) == 3
    assert "3 personnes" in reason


async def test_exact_name_wins_over_partial_matches(db: Database) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if not request.url.params.get("query"):
            return httpx.Response(200, json={})
        return httpx.Response(
            200, json=_people([("Xavier", "x@a.com"), ("Xavier-Antoine Roy", "xa@b.com")])
        )

    service = ContactsService(
        _client(db, handler, ["https://www.googleapis.com/auth/contacts.readonly"])
    )
    candidates, reason = await service.resolve_recipient("Xavier")
    assert len(candidates) == 1
    assert candidates[0].primary_email == "x@a.com"
    assert "exacte" in reason


async def test_contact_without_email_is_not_a_valid_recipient(db: Database) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if not request.url.params.get("query"):
            return httpx.Response(200, json={})
        return httpx.Response(
            200,
            json={"results": [{"person": {"names": [{"displayName": "Marc"}],
                                          "phoneNumbers": [{"value": "418-555-0000"}]}}]},
        )

    service = ContactsService(
        _client(db, handler, ["https://www.googleapis.com/auth/contacts.readonly"])
    )
    candidates, reason = await service.resolve_recipient("Marc")
    assert candidates == []
    assert "adresse courriel" in reason
