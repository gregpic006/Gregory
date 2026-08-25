"""Stockage et lecture des donnees business.

Le principe: **un chiffre ne voyage jamais seul**.  Toute valeur sortie d'ici
est accompagnee de sa couverture (combien de jours demandes, combien
reellement presents), de sa fraicheur et de sa source.

C'est ce qui separe « les ventes de la semaine: 42 000 $ » d'une phrase
honnete quand seuls trois jours sur sept ont ete importes.  Le premier est un
mensonge par omission; le second se dit « 18 200 $ sur les 3 jours dont j'ai
les donnees (mardi a jeudi) ».
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from jarvis_core.business import metrics as vocabulary
from jarvis_core.business.metrics import Aggregation, MetricDefinition
from jarvis_core.persistence.db import Database

logger = logging.getLogger(__name__)

#: Au-dela, on considere la donnee perimee et on le dit.
STALE_AFTER_DAYS = 3

NOT_CONNECTED = "not_connected"
CONNECTED = "connected"
STALE = "stale"


@dataclass(frozen=True)
class Fact:
    """Une mesure datee et sourcee."""

    org_id: str
    metric: str
    day: str
    value: float
    unit: str = ""
    source: str = "manuel"
    source_ref: str = ""


@dataclass
class MetricReading:
    """Une valeur d'indicateur, avec tout ce qui permet de la juger.

    `status` vaut `not_connected` quand aucune donnee n'existe: on n'affiche
    alors ni zero ni estimation. Un zero reel (« zero vente lundi ») est un
    fait, et se distingue d'une absence de donnee — la difference est portee
    par `status`, pas par la valeur.
    """

    metric: str
    label: str
    unit: str
    value: float | None = None
    status: str = NOT_CONNECTED
    days_requested: int = 0
    days_covered: int = 0
    last_day: str = ""
    sources: tuple[str, ...] = field(default_factory=tuple)
    detail: str = ""

    @property
    def complete(self) -> bool:
        return self.days_requested > 0 and self.days_covered >= self.days_requested

    def formatted(self) -> str | None:
        definition = vocabulary.get(self.metric)
        if self.value is None or definition is None:
            return None
        return definition.format(self.value)

    def as_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "label": self.label,
            "unit": self.unit,
            "value": self.value,
            "display": self.formatted(),
            "status": self.status,
            "days_requested": self.days_requested,
            "days_covered": self.days_covered,
            "complete": self.complete,
            "last_day": self.last_day,
            "sources": list(self.sources),
            "detail": self.detail,
        }


class BusinessStore:
    """Depot des faits business."""

    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------------ ecriture

    def record(self, facts: list[Fact]) -> int:
        """Enregistre des faits. Un meme (org, indicateur, jour, source) est remplace."""
        if not facts:
            return 0
        now = datetime.now(UTC).isoformat()
        with self.db.cursor() as cur:
            for fact in facts:
                definition = vocabulary.get(fact.metric)
                unit = fact.unit or (definition.unit if definition else "")
                cur.execute(
                    "INSERT INTO business_facts"
                    " (id, org_id, metric, day, value, unit, source, source_ref, recorded_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT (org_id, metric, day, source) DO UPDATE SET"
                    " value = excluded.value, unit = excluded.unit,"
                    " source_ref = excluded.source_ref, recorded_at = excluded.recorded_at",
                    (
                        f"bf_{uuid.uuid4().hex[:12]}",
                        fact.org_id,
                        fact.metric,
                        fact.day,
                        float(fact.value),
                        unit,
                        fact.source,
                        fact.source_ref,
                        now,
                    ),
                )
        return len(facts)

    def log_import(
        self,
        *,
        org_id: str,
        source: str,
        source_ref: str,
        rows_ok: int,
        rows_failed: int,
        detail: str = "",
    ) -> None:
        self.db.execute(
            "INSERT INTO business_imports"
            " (id, org_id, source, source_ref, rows_ok, rows_failed, detail, created_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (
                f"bi_{uuid.uuid4().hex[:10]}",
                org_id,
                source,
                source_ref,
                rows_ok,
                rows_failed,
                detail,
                datetime.now(UTC).isoformat(),
            ),
        )

    def clear(self, *, org_id: str, source: str = "") -> int:
        """Supprime les faits d'une organisation, eventuellement d'une seule source."""
        if source:
            rows = self.db.query(
                "SELECT COUNT(*) AS n FROM business_facts WHERE org_id = ? AND source = ?",
                (org_id, source),
            )
            self.db.execute(
                "DELETE FROM business_facts WHERE org_id = ? AND source = ?", (org_id, source)
            )
        else:
            rows = self.db.query(
                "SELECT COUNT(*) AS n FROM business_facts WHERE org_id = ?", (org_id,)
            )
            self.db.execute("DELETE FROM business_facts WHERE org_id = ?", (org_id,))
        return int(rows[0]["n"]) if rows else 0

    # ------------------------------------------------------------------ lecture

    def has_any_data(self, org_id: str = "") -> bool:
        sql = "SELECT 1 FROM business_facts"
        params: tuple[Any, ...] = ()
        if org_id:
            sql += " WHERE org_id = ?"
            params = (org_id,)
        return self.db.query_one(sql + " LIMIT 1", params) is not None

    def connected_metrics(self, org_id: str) -> set[str]:
        """Indicateurs pour lesquels au moins un fait existe."""
        rows = self.db.query(
            "SELECT DISTINCT metric FROM business_facts WHERE org_id = ?", (org_id,)
        )
        return {str(row["metric"]) for row in rows}

    def series(
        self, *, org_id: str, metric: str, start: str, end: str
    ) -> list[tuple[str, float, str]]:
        """Valeurs quotidiennes (jour, valeur, source) sur un intervalle inclusif."""
        rows = self.db.query(
            "SELECT day, value, source FROM business_facts"
            " WHERE org_id = ? AND metric = ? AND day BETWEEN ? AND ?"
            " ORDER BY day",
            (org_id, metric, start, end),
        )
        return [(str(r["day"]), float(r["value"]), str(r["source"])) for r in rows]

    def read(
        self, *, org_id: str, metric: str, start: date, end: date, today: date | None = None
    ) -> MetricReading:
        """Lit un indicateur sur une periode, avec sa couverture reelle.

        C'est le seul chemin de lecture: il garantit qu'aucun appelant ne peut
        obtenir une valeur sans savoir sur combien de jours elle porte.
        """
        definition = vocabulary.get(metric)
        if definition is None:
            return MetricReading(
                metric=metric,
                label=metric,
                unit="",
                status=NOT_CONNECTED,
                detail=f"Indicateur inconnu: {metric}",
            )

        requested = (end - start).days + 1
        rows = self.series(
            org_id=org_id, metric=metric, start=start.isoformat(), end=end.isoformat()
        )
        reading = MetricReading(
            metric=metric,
            label=definition.label,
            unit=definition.unit,
            days_requested=max(requested, 0),
        )

        if not rows:
            reading.status = NOT_CONNECTED
            reading.detail = _no_data_detail(self, org_id=org_id, metric=metric)
            return reading

        values = [value for _, value, _ in rows]
        reading.value = _aggregate(values, definition)
        reading.days_covered = len(rows)
        reading.last_day = rows[-1][0]
        reading.sources = tuple(sorted({source for _, _, source in rows}))

        reference = today or date.today()
        age = (reference - date.fromisoformat(reading.last_day)).days
        if age > STALE_AFTER_DAYS:
            reading.status = STALE
            reading.detail = f"Derniere donnee il y a {age} jours ({reading.last_day})"
        else:
            reading.status = CONNECTED
            if not reading.complete:
                missing = reading.days_requested - reading.days_covered
                reading.detail = (
                    f"{reading.days_covered} jour(s) sur {reading.days_requested} "
                    f"({missing} sans donnee)"
                )
        return reading

    def latest_day(self, org_id: str) -> str:
        row = self.db.query_one(
            "SELECT MAX(day) AS d FROM business_facts WHERE org_id = ?", (org_id,)
        )
        return str(row["d"]) if row and row["d"] else ""

    def recent_imports(self, *, org_id: str = "", limit: int = 10) -> list[dict[str, Any]]:
        sql = "SELECT * FROM business_imports"
        params: tuple[Any, ...] = ()
        if org_id:
            sql += " WHERE org_id = ?"
            params = (org_id,)
        sql += " ORDER BY created_at DESC LIMIT ?"
        rows = self.db.query(sql, (*params, limit))
        return [
            {
                "id": str(r["id"]),
                "org_id": str(r["org_id"]),
                "source": str(r["source"]),
                "source_ref": str(r["source_ref"]),
                "rows_ok": int(r["rows_ok"]),
                "rows_failed": int(r["rows_failed"]),
                "detail": str(r["detail"]),
                "created_at": str(r["created_at"]),
            }
            for r in rows
        ]


def _aggregate(values: list[float], definition: MetricDefinition) -> float:
    """Agrege selon la nature de l'indicateur.

    Additionner un taux d'occupation donnerait 300 % sur trois jours: chaque
    indicateur declare donc sa propre facon de se cumuler.
    """
    if definition.aggregation is Aggregation.SUM:
        return round(sum(values), 2)
    if definition.aggregation is Aggregation.AVERAGE:
        return round(sum(values) / len(values), 2)
    return round(values[-1], 2)


def _no_data_detail(store: BusinessStore, *, org_id: str, metric: str) -> str:
    """Explique pourquoi il n'y a rien: jamais branche, ou rien sur la periode.

    La nuance compte: « je n'ai jamais recu ces donnees » et « je n'ai rien
    pour cette semaine-la » n'appellent pas la meme action.
    """
    if metric in store.connected_metrics(org_id):
        return "Aucune donnee sur cette periode (l'indicateur existe par ailleurs)"
    return "Aucune source branchee pour cet indicateur"


def day_range(days: int, *, end: date | None = None) -> tuple[date, date]:
    """Intervalle inclusif des `days` derniers jours, finissant a `end`."""
    last = end or date.today()
    return last - timedelta(days=max(days, 1) - 1), last
