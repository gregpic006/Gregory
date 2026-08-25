"""Vocabulaire des indicateurs business.

Une liste fermee, volontairement.  Si le modele pouvait inventer un nom
d'indicateur, il pourrait aussi inventer sa valeur: « la marge nette de
Maguire » sortirait d'une requete vide plutot que d'une erreur franche.

Chaque indicateur declare son unite et la maniere de l'agreger sur une
periode.  Additionner des ventes a du sens; additionner un taux d'occupation
n'en a aucun — d'ou `Aggregation`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Aggregation(StrEnum):
    """Comment cumuler un indicateur sur plusieurs jours."""

    SUM = "sum"
    """Ventes, couverts: on additionne."""
    AVERAGE = "average"
    """Taux, pourcentages: on moyenne."""
    LAST = "last"
    """Etat a un instant (MRR, nombre de portes): la valeur la plus recente."""


@dataclass(frozen=True)
class MetricDefinition:
    """Un indicateur, son libelle et sa facon de s'agreger."""

    key: str
    label: str
    unit: str
    aggregation: Aggregation
    kinds: tuple[str, ...]
    """Types d'organisation ou l'indicateur a du sens."""

    def format(self, value: float) -> str:
        """Rend une valeur lisible a l'ecran comme a voix haute."""
        if self.unit == "CAD":
            return f"{value:,.2f} $".replace(",", " ")
        if self.unit == "%":
            return f"{value:.1f} %"
        if value == int(value):
            return str(int(value))
        return f"{value:.1f}"


RESTAURANT = ("restaurant",)
SAAS = ("saas",)
REAL_ESTATE = ("realestate",)

METRICS: dict[str, MetricDefinition] = {
    metric.key: metric
    for metric in (
        # --- restaurants ---
        MetricDefinition("sales", "Ventes", "CAD", Aggregation.SUM, RESTAURANT),
        MetricDefinition("covers", "Couverts", "unite", Aggregation.SUM, RESTAURANT),
        MetricDefinition("reservations", "Reservations", "unite", Aggregation.SUM, RESTAURANT),
        MetricDefinition("labour_cost", "Masse salariale", "CAD", Aggregation.SUM, RESTAURANT),
        MetricDefinition("food_cost", "Cout des aliments", "CAD", Aggregation.SUM, RESTAURANT),
        MetricDefinition("tips", "Pourboires", "CAD", Aggregation.SUM, RESTAURANT),
        # --- SaaS ---
        MetricDefinition("mrr", "Revenus recurrents", "CAD", Aggregation.LAST, SAAS),
        MetricDefinition("doors", "Portes", "unite", Aggregation.LAST, SAAS),
        MetricDefinition("customers", "Clients", "unite", Aggregation.LAST, SAAS),
        MetricDefinition("churn", "Attrition", "%", Aggregation.AVERAGE, SAAS),
        # --- immobilier ---
        MetricDefinition("units", "Logements", "unite", Aggregation.LAST, REAL_ESTATE),
        MetricDefinition("occupancy", "Occupation", "%", Aggregation.AVERAGE, REAL_ESTATE),
        MetricDefinition("rent_collected", "Loyers percus", "CAD", Aggregation.SUM, REAL_ESTATE),
        MetricDefinition("arrears", "Arrieres", "CAD", Aggregation.LAST, REAL_ESTATE),
    )
}

#: Indicateurs attendus par type d'organisation, dans l'ordre d'affichage.
BY_KIND: dict[str, list[MetricDefinition]] = {}
for definition in METRICS.values():
    for kind in definition.kinds:
        BY_KIND.setdefault(kind, []).append(definition)


def get(key: str) -> MetricDefinition | None:
    return METRICS.get(key)


def for_kind(kind: str) -> list[MetricDefinition]:
    return BY_KIND.get(kind, [])


def derived_labour_ratio(sales: float | None, labour: float | None) -> float | None:
    """Masse salariale en pourcentage des ventes.

    Retourne None si l'un des deux manque: un ratio calcule sur une moitie de
    donnees serait faux tout en ayant l'air juste.
    """
    if sales is None or labour is None or sales <= 0:
        return None
    return round(labour / sales * 100, 1)
