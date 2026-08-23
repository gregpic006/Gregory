"""Service Google Contacts (People API).

Sert la resolution d'entites: « envoie un courriel a Xavier » doit devenir une
adresse precise. Quand plusieurs personnes correspondent, on ne devine pas —
on remonte la liste et JARVIS demande laquelle.

Chemins confirmes contre le document de decouverte People v1.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from jarvis_core.integrations.google.client import GoogleClient

BASE = "https://people.googleapis.com/v1"
SCOPE_CONTACTS = "https://www.googleapis.com/auth/contacts.readonly"
READ_MASK = "names,emailAddresses,phoneNumbers,organizations"


@dataclass
class Contact:
    """Une personne du carnet d'adresses."""

    name: str
    emails: list[str] = field(default_factory=list)
    phones: list[str] = field(default_factory=list)
    organization: str = ""

    @property
    def primary_email(self) -> str:
        return self.emails[0] if self.emails else ""

    def spoken_line(self) -> str:
        org = f" ({self.organization})" if self.organization else ""
        contact = self.primary_email or (self.phones[0] if self.phones else "sans coordonnees")
        return f"{self.name}{org} — {contact}"

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "emails": self.emails,
            "phones": self.phones,
            "organization": self.organization,
        }


def _to_contact(person: dict[str, Any]) -> Contact:
    names = person.get("names") or []
    organizations = person.get("organizations") or []
    return Contact(
        name=(names[0].get("displayName", "") if names else "") or "(sans nom)",
        emails=[e["value"] for e in person.get("emailAddresses") or [] if e.get("value")],
        phones=[p["value"] for p in person.get("phoneNumbers") or [] if p.get("value")],
        organization=(organizations[0].get("name", "") if organizations else ""),
    )


class ContactsService:
    """Recherche dans le carnet d'adresses."""

    def __init__(self, client: GoogleClient) -> None:
        self.client = client
        self._warmed = False

    async def _warm_up(self) -> None:
        """La recherche People exige une requete d'amorcage.

        L'API construit un index cote serveur au premier appel; sans cet
        amorcage, la premiere vraie recherche revient vide. On l'absorbe ici
        pour que l'appelant n'ait jamais a y penser.
        """
        if self._warmed:
            return
        await self.client.request(
            "GET",
            f"{BASE}/people:searchContacts",
            params={"query": "", "readMask": READ_MASK, "pageSize": 1},
        )
        self._warmed = True

    async def search(self, query: str, *, limit: int = 10) -> list[Contact]:
        """Cherche une personne par nom, adresse ou organisation."""
        self.client.require_scope(SCOPE_CONTACTS, "consulter tes contacts")
        await self._warm_up()
        payload = await self.client.request(
            "GET",
            f"{BASE}/people:searchContacts",
            params={
                "query": query,
                "readMask": READ_MASK,
                "pageSize": max(1, min(limit, 30)),
            },
        )
        results = payload.get("results") or []
        return [_to_contact(item.get("person") or {}) for item in results]

    async def resolve_recipient(self, name: str) -> tuple[list[Contact], str]:
        """Resout un nom en destinataire.

        Returns:
            (candidats, raison). Un seul candidat avec courriel = resolution
            certaine. Zero ou plusieurs = JARVIS doit demander.
        """
        candidates = [c for c in await self.search(name, limit=10) if c.emails]
        if not candidates:
            return [], f"Aucun contact nomme « {name} » avec une adresse courriel."
        if len(candidates) == 1:
            return candidates, "resolution certaine"
        exact = [c for c in candidates if c.name.lower().strip() == name.lower().strip()]
        if len(exact) == 1:
            return exact, "correspondance exacte du nom"
        return candidates, f"{len(candidates)} personnes correspondent a « {name} »."
