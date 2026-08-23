"""Service Google Calendar.

Chemins et parametres confirmes contre le document de decouverte Calendar v3.
La portee `calendar.events` couvre lecture et ecriture des evenements — et
rien d'autre: ni les parametres du compte, ni la liste des agendas.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from jarvis_core.integrations.google.client import GoogleClient
from jarvis_core.timeutils import format_datetime_fr

BASE = "https://www.googleapis.com/calendar/v3"
SCOPE_EVENTS = "https://www.googleapis.com/auth/calendar.events"


@dataclass
class CalendarEvent:
    """Un evenement d'agenda, normalise."""

    id: str
    title: str
    start: str
    end: str
    all_day: bool
    location: str = ""
    attendees: list[str] = field(default_factory=list)
    organizer: str = ""
    status: str = "confirmed"
    html_link: str = ""
    description: str = ""

    def spoken_line(self, timezone: str) -> str:
        """Ligne lisible a voix haute."""
        if self.all_day:
            when = f"toute la journee du {self.start[:10]}"
        else:
            try:
                when = format_datetime_fr(datetime.fromisoformat(self.start), timezone)
            except ValueError:
                when = self.start
        where = f", {self.location}" if self.location else ""
        who = f" avec {', '.join(self.attendees[:3])}" if self.attendees else ""
        return f"{self.title or '(sans titre)'} — {when}{where}{who}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "start": self.start,
            "end": self.end,
            "all_day": self.all_day,
            "location": self.location,
            "attendees": self.attendees,
            "status": self.status,
            "link": self.html_link,
        }


def _endpoint(value: dict[str, Any]) -> tuple[str, bool]:
    """Extrait (instant ISO, journee_entiere) d'un `start`/`end` Google."""
    if "dateTime" in value:
        return value["dateTime"], False
    return value.get("date", ""), True


def _to_event(raw: dict[str, Any]) -> CalendarEvent:
    start, all_day = _endpoint(raw.get("start") or {})
    end, _ = _endpoint(raw.get("end") or {})
    attendees = [
        a.get("email", "")
        for a in raw.get("attendees") or []
        if a.get("email") and not a.get("self")
    ]
    return CalendarEvent(
        id=raw.get("id", ""),
        title=raw.get("summary", ""),
        start=start,
        end=end,
        all_day=all_day,
        location=raw.get("location", ""),
        attendees=attendees,
        organizer=(raw.get("organizer") or {}).get("email", ""),
        status=raw.get("status", "confirmed"),
        html_link=raw.get("htmlLink", ""),
        description=raw.get("description", ""),
    )


class CalendarService:
    """Operations d'agenda utilisees par les outils."""

    def __init__(self, client: GoogleClient, *, calendar_id: str = "primary") -> None:
        self.client = client
        self.calendar_id = calendar_id

    async def list_events(
        self, *, start: str, end: str, limit: int = 20, query: str = ""
    ) -> list[CalendarEvent]:
        """Evenements d'une periode, tries chronologiquement.

        `singleEvents=true` developpe les series recurrentes en occurrences
        concretes: sans lui, « qu'est-ce que j'ai demain » manquerait les
        rendez-vous recurrents.
        """
        self.client.require_scope(SCOPE_EVENTS, "consulter ton calendrier")
        params: dict[str, Any] = {
            "timeMin": start,
            "timeMax": end,
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": max(1, min(limit, 50)),
        }
        if query:
            params["q"] = query
        payload = await self.client.request(
            "GET", f"{BASE}/calendars/{self.calendar_id}/events", params=params
        )
        events = [_to_event(item) for item in payload.get("items") or []]
        return [event for event in events if event.status != "cancelled"]

    async def get_event(self, event_id: str) -> CalendarEvent:
        self.client.require_scope(SCOPE_EVENTS, "consulter ton calendrier")
        raw = await self.client.request(
            "GET", f"{BASE}/calendars/{self.calendar_id}/events/{event_id}"
        )
        return _to_event(raw)

    async def create_event(
        self,
        *,
        title: str,
        start: str,
        end: str,
        timezone: str,
        attendees: list[str] | None = None,
        location: str = "",
        description: str = "",
    ) -> CalendarEvent:
        self.client.require_scope(SCOPE_EVENTS, "modifier ton calendrier")
        body: dict[str, Any] = {
            "summary": title,
            "start": {"dateTime": start, "timeZone": timezone},
            "end": {"dateTime": end, "timeZone": timezone},
        }
        if location:
            body["location"] = location
        if description:
            body["description"] = description
        if attendees:
            body["attendees"] = [{"email": email} for email in attendees]
        raw = await self.client.request(
            "POST",
            f"{BASE}/calendars/{self.calendar_id}/events",
            params={"sendUpdates": "all" if attendees else "none"},
            json_body=body,
        )
        return _to_event(raw)

    async def update_event(
        self,
        event_id: str,
        *,
        title: str = "",
        start: str = "",
        end: str = "",
        timezone: str = "",
        location: str = "",
    ) -> CalendarEvent:
        """Modification partielle: seuls les champs fournis sont touches."""
        self.client.require_scope(SCOPE_EVENTS, "modifier ton calendrier")
        body: dict[str, Any] = {}
        if title:
            body["summary"] = title
        if start:
            body["start"] = {"dateTime": start, "timeZone": timezone}
        if end:
            body["end"] = {"dateTime": end, "timeZone": timezone}
        if location:
            body["location"] = location
        if not body:
            return await self.get_event(event_id)
        raw = await self.client.request(
            "PATCH",
            f"{BASE}/calendars/{self.calendar_id}/events/{event_id}",
            params={"sendUpdates": "all"},
            json_body=body,
        )
        return _to_event(raw)

    async def cancel_event(self, event_id: str) -> None:
        """Supprime un evenement. Palier 3: confirmation obligatoire en amont."""
        self.client.require_scope(SCOPE_EVENTS, "modifier ton calendrier")
        await self.client.request(
            "DELETE",
            f"{BASE}/calendars/{self.calendar_id}/events/{event_id}",
            params={"sendUpdates": "all"},
        )
