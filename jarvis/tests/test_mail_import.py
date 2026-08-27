"""Import des rapports recus par courriel.

C'est la voie d'integration qui ne demande ni entente avec un fournisseur, ni
cle d'API, ni mot de passe. Ces tests verrouillent ce qui la rend sure: on
n'importe que ce qu'un utilisateur a designe, jamais deux fois, et un rapport
illisible est signale au lieu d'etre devine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from jarvis_core.business.mail_import import (
    MailRule,
    MailRuleStore,
    scan_mailbox,
)
from jarvis_core.business.store import BusinessStore
from jarvis_core.config import Settings
from jarvis_core.integrations.google.gmail import extract_attachments

VENTES = "date,ventes\n2026-08-20,1250.50\n2026-08-21,1410.00\n"


# ------------------------------------------------------------- pieces jointes


def test_an_attachment_is_recognised_in_a_nested_payload() -> None:
    """Gmail imbrique les parties: un rapport est souvent a deux niveaux."""
    payload = {
        "mimeType": "multipart/mixed",
        "parts": [
            {"mimeType": "text/plain", "body": {"size": 12, "data": "aGk="}},
            {
                "mimeType": "multipart/alternative",
                "parts": [
                    {
                        "filename": "ventes.csv",
                        "mimeType": "text/csv",
                        "body": {"attachmentId": "att-1", "size": 220},
                    }
                ],
            },
        ],
    }
    found = extract_attachments(payload)
    assert [a.filename for a in found] == ["ventes.csv"]
    assert found[0].id == "att-1"
    assert found[0].looks_tabular is True


def test_a_body_part_is_not_mistaken_for_an_attachment() -> None:
    """Une partie de texte porte ses octets, pas un `attachmentId`."""
    payload = {"mimeType": "text/plain", "body": {"size": 40, "data": "aGk="}}
    assert extract_attachments(payload) == []


def test_a_pdf_is_not_treated_as_a_table() -> None:
    """On ne devine pas des chiffres dans un PDF: on le saute et on le dit."""
    payload = {
        "filename": "rapport.pdf",
        "mimeType": "application/pdf",
        "body": {"attachmentId": "att-9", "size": 900},
    }
    assert extract_attachments(payload)[0].looks_tabular is False


# --------------------------------------------------------------- la requete


def test_the_query_asks_gmail_to_do_the_filtering() -> None:
    """Rapatrier des courriels pour les jeter ensuite serait du gaspillage."""
    rule = MailRule(id="r1", org_id="RESTO", sender="rapports@caisse.com")
    query = rule.query(days=7)
    assert "from:rapports@caisse.com" in query
    assert "has:attachment" in query
    assert "newer_than:7d" in query


def test_a_multi_word_subject_stays_one_criterion() -> None:
    """Sans guillemets, « rapport des ventes » deviendrait trois criteres."""
    rule = MailRule(id="r1", org_id="RESTO", sender="x@y.com", subject="rapport des ventes")
    assert 'subject:"rapport des ventes"' in rule.query()


# ------------------------------------------------------------ le double envoi


@dataclass
class FakeAttachment:
    id: str
    filename: str
    mime: str = "text/csv"
    size: int = 200

    @property
    def looks_tabular(self) -> bool:
        return self.filename.lower().endswith((".csv", ".txt", ".tsv"))


@dataclass
class FakeMessage:
    id: str
    subject: str = "Rapport quotidien"


@dataclass
class FakeGmail:
    messages: list[FakeMessage]
    payloads: dict[str, bytes]
    attachments: dict[str, list[FakeAttachment]]
    queries: list[str] = field(default_factory=list)
    downloads: list[str] = field(default_factory=list)

    async def search(self, query: str, *, limit: int = 10) -> list[FakeMessage]:
        self.queries.append(query)
        return self.messages

    async def list_attachments(self, message_id: str) -> list[FakeAttachment]:
        return self.attachments.get(message_id, [])

    async def download_attachment(self, message_id: str, attachment_id: str, **_: Any) -> bytes:
        self.downloads.append(attachment_id)
        return self.payloads.get(attachment_id, b"")


@dataclass
class FakeGoogle:
    gmail: FakeGmail
    connected: bool = True


@dataclass
class FakeRuntime:
    db: Any
    business: Any
    google: Any
    settings: Settings


@pytest.fixture()
def runtime(tmp_path: Any) -> FakeRuntime:
    from jarvis_core.persistence.db import Database

    db = Database(f"sqlite:///{tmp_path}/t.db")
    db.migrate()
    db.execute(
        "INSERT INTO organizations (id, name, kind, position, archived, created_at)"
        " VALUES ('RESTO', 'Le Resto', 'restaurant', 0, 0, '2026-01-01')"
    )
    gmail = FakeGmail(
        messages=[FakeMessage(id="m1")],
        payloads={"att-1": VENTES.encode("utf-8")},
        attachments={"m1": [FakeAttachment(id="att-1", filename="ventes.csv")]},
    )
    return FakeRuntime(
        db=db,
        business=BusinessStore(db),
        google=FakeGoogle(gmail=gmail),
        settings=Settings(JARVIS_FEATURE_GMAIL="true"),
    )


@pytest.mark.asyncio
async def test_a_report_is_imported_once(runtime: FakeRuntime) -> None:
    MailRuleStore(runtime.db).add(org_id="RESTO", sender="rapports@caisse.com")

    first = await scan_mailbox(runtime)
    assert first.imported and first.rows == 2

    # La caisse renvoie le meme courriel, la surveillance repasse: rien ne
    # doit entrer une seconde fois, sinon les ventes doubleraient.
    second = await scan_mailbox(runtime)
    assert second.imported == []
    assert second.already_seen == 1


@pytest.mark.asyncio
async def test_a_failed_import_is_retried_next_time(runtime: FakeRuntime) -> None:
    """Une panne passagere ne doit pas condamner un rapport pour toujours.

    Retenir le courriel des qu'on l'a vu — plutot qu'une fois importe —
    ferait perdre definitivement la journee ou Gmail a hoquete.
    """
    runtime.google.gmail.payloads = {}  # telechargement vide: echec
    MailRuleStore(runtime.db).add(org_id="RESTO", sender="rapports@caisse.com")

    first = await scan_mailbox(runtime)
    assert first.imported == [] and first.failed

    runtime.google.gmail.payloads = {"att-1": VENTES.encode("utf-8")}
    second = await scan_mailbox(runtime)
    assert second.imported and second.rows == 2


@pytest.mark.asyncio
async def test_nothing_is_read_without_a_rule(runtime: FakeRuntime) -> None:
    """Aucune deduction: JARVIS ne fouille pas une boite pour deviner."""
    report = await scan_mailbox(runtime)

    assert report.imported == []
    assert runtime.google.gmail.queries == []


@pytest.mark.asyncio
async def test_a_pdf_report_is_reported_not_guessed(runtime: FakeRuntime) -> None:
    """Un rapport qu'on ne sait pas lire se dit, il ne s'invente pas."""
    runtime.google.gmail.attachments = {
        "m1": [FakeAttachment(id="att-1", filename="rapport.pdf", mime="application/pdf")]
    }
    MailRuleStore(runtime.db).add(org_id="RESTO", sender="rapports@caisse.com")

    report = await scan_mailbox(runtime)
    assert report.imported == []
    assert report.skipped and "CSV" in report.skipped[0][1]


@pytest.mark.asyncio
async def test_gmail_not_connected_is_said_not_silently_empty(runtime: FakeRuntime) -> None:
    """« Rien de nouveau » sur une source non branchee serait un mensonge."""
    runtime.google.connected = False
    MailRuleStore(runtime.db).add(org_id="RESTO", sender="rapports@caisse.com")

    report = await scan_mailbox(runtime)
    assert "Gmail" in report.error


@pytest.mark.asyncio
async def test_a_rule_pointing_at_an_archived_business_is_skipped(
    runtime: FakeRuntime,
) -> None:
    """Les entreprises appartiennent a l'utilisateur: il peut en retirer une.

    Elles sont archivees, pas supprimees — la cle etrangere refuserait de
    laisser une regle pointer dans le vide. Une regle orpheline doit donc etre
    ignoree, et dite, pas executee sur une entreprise retiree.
    """
    MailRuleStore(runtime.db).add(org_id="RESTO", sender="rapports@caisse.com")
    runtime.db.execute("UPDATE organizations SET archived = 1 WHERE id = 'RESTO'")

    report = await scan_mailbox(runtime)
    assert report.imported == []
    assert report.skipped


@pytest.mark.asyncio
async def test_two_businesses_can_receive_the_same_report(runtime: FakeRuntime) -> None:
    """La cle est (courriel, entreprise): un rapport partage reste legitime."""
    runtime.db.execute(
        "INSERT INTO organizations (id, name, kind, position, archived, created_at)"
        " VALUES ('AUTRE', 'Autre', 'restaurant', 1, 0, '2026-01-01')"
    )
    rules = MailRuleStore(runtime.db)
    rules.add(org_id="RESTO", sender="rapports@caisse.com")
    rules.add(org_id="AUTRE", sender="rapports@caisse.com")

    report = await scan_mailbox(runtime)
    assert len(report.imported) == 2


def test_rules_can_be_listed_and_removed(runtime: FakeRuntime) -> None:
    rules = MailRuleStore(runtime.db)
    rule = rules.add(org_id="RESTO", sender="a@b.com", label="Ventes")

    assert [r.id for r in rules.list_rules()] == [rule.id]
    assert rules.remove(rule.id) is True
    assert rules.list_rules() == []
    assert rules.remove(rule.id) is False
