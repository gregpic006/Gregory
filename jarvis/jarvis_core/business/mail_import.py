"""Import des rapports recus par courriel.

C'est la reponse la plus solide a « connecte mon application de gestion »
quand le fournisseur n'offre pas d'API — ce qui est le cas le plus frequent.
Maitre'D, par exemple, n'a pas d'API en libre-service: l'integration passe par
une entente commerciale avec PayFacto, et le logiciel tourne souvent sur un
serveur dans le restaurant, hors d'atteinte depuis l'exterieur.

Mais presque tous ces logiciels savent **envoyer un rapport par courriel a
heure fixe**. Le rapport arrive alors dans une boite a laquelle JARVIS a deja
acces, en lecture seule, avec une autorisation que l'utilisateur a lui-meme
accordee.

Aucune entente, aucune cle d'API, **et surtout aucun mot de passe**: JARVIS ne
se connecte jamais a l'application de gestion. Il lit un courriel que cette
application lui a envoye. La difference est essentielle — un identifiant
confie a un tiers reste confie a un tiers, meme quand ce tiers est un
assistant.

Quatre precautions.

**Un courriel deja importe ne l'est jamais deux fois.** La caisse envoie le
meme rapport chaque jour et la surveillance repasse chaque heure. L'unicite
est portee par la base.

**Le contenu d'un courriel est une donnee, jamais une instruction.** Les
pieces jointes passent par le meme lecteur CSV que les fichiers deposes a la
main, avec les memes refus.

**Seul un expediteur nomme par l'utilisateur est lu.** Aucune regle par
defaut, aucune deduction: JARVIS n'ira pas fouiller une boite pour deviner ce
qui ressemble a un rapport.

**Un rapport illisible est signale, pas devine.** Si la piece jointe ne se
lit pas, on le dit; on n'invente pas un chiffre plausible.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from jarvis_core.business.csv_import import ImportError_, import_csv
from jarvis_core.business.store import BusinessStore
from jarvis_core.persistence.db import Database

logger = logging.getLogger(__name__)

#: Fenetre de recherche par defaut. Assez large pour rattraper une panne de
#: quelques jours, assez etroite pour ne pas relire une annee a chaque tour.
DEFAULT_LOOKBACK_DAYS = 14

#: Au-dela, on arrete de parcourir: une regle qui ramene autant de courriels
#: est trop large, et le dire vaut mieux que de tourner sans fin.
MAX_MESSAGES = 25


@dataclass(frozen=True)
class MailRule:
    """« Quand cet expediteur m'ecrit, importe-le dans cette entreprise. »"""

    id: str
    org_id: str
    sender: str
    subject: str = ""
    label: str = ""
    enabled: bool = True
    last_run_at: str = ""

    def query(self, *, days: int = DEFAULT_LOOKBACK_DAYS) -> str:
        """Requete Gmail correspondante.

        `has:attachment` reduit d'emblee: un rapport sans piece jointe n'est
        pas importable, et le demander a Gmail evite de rapatrier des
        courriels pour rien.
        """
        parts = [f"from:{self.sender}", "has:attachment", f"newer_than:{days}d"]
        if self.subject.strip():
            # Les guillemets gardent l'objet en un seul terme: sans eux,
            # « rapport des ventes » deviendrait trois criteres.
            parts.append(f'subject:"{self.subject.strip()}"')
        return " ".join(parts)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "sender": self.sender,
            "subject": self.subject,
            "label": self.label,
            "enabled": self.enabled,
            "last_run_at": self.last_run_at,
        }


@dataclass
class MailImportReport:
    """Ce qu'un passage a fait, source par source."""

    imported: list[str] = field(default_factory=list)
    already_seen: int = 0
    skipped: list[tuple[str, str]] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    rows: int = 0
    error: str = ""

    @property
    def changed(self) -> bool:
        return bool(self.imported)

    def summary(self) -> str:
        if self.error:
            return self.error
        parts: list[str] = []
        if self.imported:
            parts.append(f"{len(self.imported)} rapport(s) importe(s)")
        if self.already_seen:
            parts.append(f"{self.already_seen} deja connu(s)")
        if self.failed:
            parts.append(f"{len(self.failed)} en echec")
        return ", ".join(parts) if parts else "rien de nouveau"

    def as_dict(self) -> dict[str, Any]:
        return {
            "imported": self.imported,
            "already_seen": self.already_seen,
            "skipped": [{"name": n, "reason": r} for n, r in self.skipped],
            "failed": [{"name": n, "reason": r} for n, r in self.failed],
            "rows": self.rows,
            "error": self.error,
            "summary": self.summary(),
        }


class MailRuleStore:
    """Les regles, et la memoire de ce qui a deja ete importe."""

    def __init__(self, db: Database) -> None:
        self.db = db

    def add(self, *, org_id: str, sender: str, subject: str = "", label: str = "") -> MailRule:
        rule = MailRule(
            id=f"mr_{uuid.uuid4().hex[:10]}",
            org_id=org_id,
            sender=sender.strip(),
            subject=subject.strip(),
            label=label.strip(),
        )
        self.db.execute(
            "INSERT INTO business_mail_rules"
            " (id, org_id, sender, subject, label, enabled, created_at)"
            " VALUES (?,?,?,?,?,1,?)",
            (
                rule.id,
                rule.org_id,
                rule.sender,
                rule.subject,
                rule.label,
                datetime.now(UTC).isoformat(),
            ),
        )
        return rule

    def remove(self, rule_id: str) -> bool:
        if not self.db.query_one("SELECT id FROM business_mail_rules WHERE id = ?", (rule_id,)):
            return False
        self.db.execute("DELETE FROM business_mail_rules WHERE id = ?", (rule_id,))
        return True

    def list_rules(self, *, only_enabled: bool = False) -> list[MailRule]:
        clause = " WHERE enabled = 1" if only_enabled else ""
        rows = self.db.query(
            f"SELECT * FROM business_mail_rules{clause} ORDER BY created_at"
        )
        return [
            MailRule(
                id=str(row["id"]),
                org_id=str(row["org_id"]),
                sender=str(row["sender"]),
                subject=str(row["subject"]),
                label=str(row["label"]),
                enabled=bool(row["enabled"]),
                last_run_at=str(row["last_run_at"]),
            )
            for row in rows
        ]

    def mark_run(self, rule_id: str) -> None:
        self.db.execute(
            "UPDATE business_mail_rules SET last_run_at = ? WHERE id = ?",
            (datetime.now(UTC).isoformat(), rule_id),
        )

    def already_imported(self, message_id: str, org_id: str) -> bool:
        return (
            self.db.query_one(
                "SELECT message_id FROM business_mail_seen"
                " WHERE message_id = ? AND org_id = ?",
                (message_id, org_id),
            )
            is not None
        )

    def remember(self, message_id: str, org_id: str) -> bool:
        """Retient un courriel importe. Faux s'il l'etait deja.

        `INSERT OR IGNORE` sur une cle primaire composee: c'est la base qui
        garantit l'unicite, pas une verification qu'on pourrait oublier.
        """
        with self.db.cursor() as cur:
            cur.execute(
                "INSERT OR IGNORE INTO business_mail_seen"
                " (message_id, org_id, imported_at) VALUES (?,?,?)",
                (message_id, org_id, datetime.now(UTC).isoformat()),
            )
            return bool(cur.rowcount)


def _decode(payload: bytes) -> str:
    """Decode une piece jointe. Les exports Windows sont souvent en cp1252."""
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return payload.decode(encoding)
        except UnicodeDecodeError:
            continue
    return payload.decode("utf-8", errors="replace")


async def scan_mailbox(
    runtime: Any,
    *,
    days: int = DEFAULT_LOOKBACK_DAYS,
    rule_id: str = "",
) -> MailImportReport:
    """Cherche les rapports recus et importe ceux qui sont nouveaux."""
    report = MailImportReport()

    google = getattr(runtime, "google", None)
    if google is None or not google.connected or not runtime.settings.feature_gmail:
        report.error = "Gmail n'est pas connecte."
        return report

    store = getattr(runtime, "business", None)
    if store is None:
        report.error = "Les donnees business ne sont pas activees."
        return report

    rules = MailRuleStore(runtime.db)
    known = {
        str(row["id"]): str(row["kind"])
        for row in runtime.db.query("SELECT id, kind FROM organizations WHERE archived = 0")
    }

    for rule in rules.list_rules(only_enabled=True):
        if rule_id and rule.id != rule_id:
            continue
        if rule.org_id not in known:
            report.skipped.append((rule.sender, "l'entreprise de cette regle n'existe plus"))
            continue
        await _run_rule(google, store, rules, rule, known[rule.org_id], days, report)
        rules.mark_run(rule.id)

    return report


async def _run_rule(
    google: Any,
    store: BusinessStore,
    rules: MailRuleStore,
    rule: MailRule,
    kind: str,
    days: int,
    report: MailImportReport,
) -> None:
    """Traite une regle. Un echec ici n'arrete pas les autres regles."""
    try:
        messages = await google.gmail.search(rule.query(days=days), limit=MAX_MESSAGES)
    except Exception as exc:  # noqa: BLE001 - une panne se dit, ne s'invente pas
        logger.warning("recherche de rapports impossible (%s): %s", rule.sender, exc)
        report.failed.append((rule.sender, "Gmail n'a pas repondu."))
        return

    for message in messages:
        message_id = str(getattr(message, "id", ""))
        if not message_id:
            continue
        if rules.already_imported(message_id, rule.org_id):
            report.already_seen += 1
            continue

        try:
            attachments = await google.gmail.list_attachments(message_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("pieces jointes illisibles (%s): %s", message_id, exc)
            subject = getattr(message, "subject", "") or message_id
            report.failed.append((subject, "pieces jointes illisibles"))
            continue

        tabular = [item for item in attachments if item.looks_tabular]
        if not tabular:
            report.skipped.append(
                (
                    getattr(message, "subject", "") or message_id,
                    "aucune piece jointe tabulaire (CSV attendu)",
                )
            )
            continue

        imported_any = False
        for attachment in tabular:
            if await _import_one(
                google, store, rule, kind, message, message_id, attachment, report
            ):
                imported_any = True

        # On ne retient le courriel que si quelque chose en est sorti: sinon
        # une panne passagere le condamnerait a ne jamais etre reessaye.
        if imported_any:
            rules.remember(message_id, rule.org_id)


async def _import_one(
    google: Any,
    store: BusinessStore,
    rule: MailRule,
    kind: str,
    message: Any,
    message_id: str,
    attachment: Any,
    report: MailImportReport,
) -> bool:
    """Importe une piece jointe. Retourne vrai si des lignes sont entrees."""
    label = f"{attachment.filename} ({getattr(message, 'subject', '') or 'sans objet'})"
    try:
        payload = await google.gmail.download_attachment(message_id, attachment.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("telechargement impossible (%s): %s", attachment.filename, exc)
        report.failed.append((label, "telechargement impossible"))
        return False

    if not payload:
        report.failed.append((label, "piece jointe vide"))
        return False

    try:
        result = import_csv(
            store,
            _decode(payload),
            org_id=rule.org_id,
            kind=kind,
            source_ref=attachment.filename,
            source="courriel",
        )
    except ImportError_ as exc:
        logger.info("rapport refuse (%s): %s", attachment.filename, exc)
        report.failed.append((label, exc.user_message))
        return False

    if not result.rows_ok:
        report.failed.append((label, "aucune ligne exploitable"))
        return False

    store.log_import(
        org_id=rule.org_id,
        source="courriel",
        source_ref=attachment.filename,
        rows_ok=result.rows_ok,
        rows_failed=result.rows_failed,
        detail=f"courriel:{message_id} {result.summary()}",
    )
    report.imported.append(label)
    report.rows += result.rows_ok
    return True
