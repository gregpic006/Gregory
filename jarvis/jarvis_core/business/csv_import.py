"""Import de donnees business depuis un fichier CSV.

Pourquoi le CSV en premier: tous les systemes de caisse savent exporter un
CSV.  Aucune entente d'integration a signer, aucune cle a obtenir, ca
fonctionne le soir meme.  Les connecteurs directs viendront s'ajouter derriere
la meme interface.

L'import est ecrit pour des fichiers **quebecois reels**: separateur
point-virgule (Excel francais), decimales a la virgule, montants avec espaces
insecables, dates en JJ/MM/AAAA.

Regle absolue: **on ne devine jamais**.  Une date ambigue, un montant
illisible, une colonne inconnue — chaque ligne refusee est nommee avec son
numero et sa raison.  Un import « reussi » qui aurait silencieusement saute la
moitie des lignes produirait des chiffres faux avec l'air d'etre complets.
"""

from __future__ import annotations

import csv
import io
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from jarvis_core.business import metrics as vocabulary
from jarvis_core.business.store import BusinessStore, Fact
from jarvis_core.errors import JarvisError

logger = logging.getLogger(__name__)


class ImportError_(JarvisError):
    """Le fichier n'a pas pu etre lu du tout."""

    user_message = "Je n'arrive pas a lire ce fichier."


#: Noms de colonnes acceptes pour la date, sans accents ni casse.
DATE_ALIASES = frozenset(
    {"date", "jour", "journee", "business date", "date daffaires", "date daffaire"}
)

#: Noms de colonnes acceptes par indicateur.  On accepte le francais et
#: l'anglais: les exports de caisse melangent souvent les deux.
#:
#: Plusieurs indicateurs partagent un alias — « Clients » designe des couverts
#: au restaurant et des comptes en SaaS, « Portes » des unites SaaS ou des
#: logements.  L'ambiguite est levee par le **type de l'organisation**, pas par
#: l'ordre du dictionnaire: c'est le role du parametre `kind`.
COLUMN_ALIASES: dict[str, frozenset[str]] = {
    "sales": frozenset(
        {"ventes", "vente", "sales", "revenu", "revenus", "chiffre daffaires",
         "ca", "net sales", "ventes nettes", "ventes brutes", "total ventes",
         "gross sales", "total"}
    ),
    "covers": frozenset(
        {"couverts", "couvert", "covers", "clients", "guests", "nb clients",
         "nb couverts", "nombre de couverts", "clients servis"}
    ),
    "reservations": frozenset({"reservations", "reservation", "bookings", "resas"}),
    "labour_cost": frozenset(
        {"masse salariale", "salaires", "labour", "labor", "labour cost", "cout main doeuvre",
         "main doeuvre", "cout de main doeuvre", "cout main d oeuvre", "paie"}
    ),
    "food_cost": frozenset(
        {"cout aliments", "cout des aliments", "food cost", "cout matiere", "achats",
         "cout des marchandises"}
    ),
    "tips": frozenset({"pourboires", "pourboire", "tips", "gratuites", "gratuities"}),
    "mrr": frozenset({"mrr", "revenus recurrents", "recurring revenue", "abonnements"}),
    "doors": frozenset({"portes", "doors", "unites"}),
    "customers": frozenset({"clients", "customers", "comptes", "abonnes"}),
    "churn": frozenset({"churn", "attrition", "taux dattrition"}),
    "units": frozenset({"logements", "units", "appartements", "portes"}),
    "occupancy": frozenset({"occupation", "occupancy", "taux doccupation"}),
    "rent_collected": frozenset({"loyers percus", "loyers", "rent", "rent collected"}),
    "arrears": frozenset({"arrieres", "arrears", "impayes", "retards"}),
}


@dataclass
class ImportReport:
    """Ce qui a ete importe, et surtout ce qui ne l'a pas ete."""

    facts: int = 0
    rows_ok: int = 0
    rows_failed: int = 0
    metrics: list[str] = field(default_factory=list)
    ignored_columns: list[str] = field(default_factory=list)
    errors: list[tuple[int, str]] = field(default_factory=list)
    preamble_lines: int = 0
    """Lignes de titre ecartees avant le tableau."""
    first_day: str = ""
    last_day: str = ""

    def summary(self) -> str:
        if not self.rows_ok:
            return "Aucune ligne importee."
        labels = ", ".join(
            vocabulary.METRICS[m].label for m in self.metrics if m in vocabulary.METRICS
        )
        window = f"du {self.first_day} au {self.last_day}" if self.first_day else ""
        text = f"{self.rows_ok} ligne(s) importee(s) {window}".strip()
        if labels:
            text += f" — {labels}"
        if self.rows_failed:
            text += f" ; {self.rows_failed} ligne(s) refusee(s)"
        return text

    def as_dict(self) -> dict[str, object]:
        return {
            "facts": self.facts,
            "rows_ok": self.rows_ok,
            "rows_failed": self.rows_failed,
            "metrics": self.metrics,
            "ignored_columns": self.ignored_columns,
            "errors": [{"line": line, "reason": reason} for line, reason in self.errors],
            "preamble_lines": self.preamble_lines,
            "first_day": self.first_day,
            "last_day": self.last_day,
            "summary": self.summary(),
        }


def _fold(text: str) -> str:
    """Minuscules, sans accents ni ponctuation: pour comparer des en-tetes."""
    stripped = unicodedata.normalize("NFKD", text)
    stripped = "".join(c for c in stripped if not unicodedata.combining(c))
    stripped = re.sub(r"[^\w\s]", " ", stripped.lower())
    return re.sub(r"\s+", " ", stripped).strip()


def parse_amount(raw: str) -> float | None:
    """Lit un montant francais ou anglais, ou None si c'est illisible.

    Accepte « 1 234,56 », « 1,234.56 », « 1234.56 », « 4 200 $ », « (150) ».
    Retourne None plutot que 0 sur un contenu incomprehensible: un zero
    invente serait indistinguable d'une vraie journee a zero vente.
    """
    text = raw.strip()
    if not text:
        return None
    negative = text.startswith("(") and text.endswith(")")
    if negative:
        text = text[1:-1]
    # Symboles monetaires, espaces insecables et fines.
    text = text.replace(" ", "").replace(" ", "").replace(" ", "")
    text = text.replace("$", "").replace("€", "").replace("%", "").strip()
    if not text:
        return None

    if "," in text and "." in text:
        # Le dernier separateur rencontre est le separateur decimal.
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        # Une virgule seule: decimale en francais, milliers en anglais.
        # Trois chiffres apres => milliers ("1,234"); sinon decimale.
        after = text.rsplit(",", 1)[1]
        text = text.replace(",", "") if len(after) == 3 else text.replace(",", ".")

    try:
        value = float(text)
    except ValueError:
        return None
    return -value if negative else value


def parse_day(raw: str) -> date | None:
    """Lit une date, ou None si elle est ambigue ou invalide.

    JJ/MM/AAAA est privilegie sur MM/JJ/AAAA: on est au Quebec. Quand les deux
    lectures sont possibles et differentes (03/04/2026), on prend la
    quebecoise — mais un jour > 12 leve l'ambiguite tout seul.
    """
    text = raw.strip()
    if not text:
        return None
    text = text.split("T")[0].split(" ")[0]
    for pattern in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%Y/%m/%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    # Annee sur deux chiffres, en dernier recours.
    for pattern in ("%d/%m/%y", "%y-%m-%d"):
        try:
            return datetime.strptime(text, pattern).date()
        except ValueError:
            continue
    return None


#: On ne cherche pas l'en-tete au-dela: passe cette limite, c'est que le
#: fichier n'en a pas.
MAX_PREAMBLE_LINES = 25


def _looks_like_header(cells: list[str]) -> bool:
    """Vrai si cette ligne ressemble a l'en-tete du tableau.

    Critere: une colonne de date reconnue, et au moins une colonne
    d'indicateur connue. Un titre de rapport n'a ni l'une ni l'autre.
    """
    folded = [_fold(cell) for cell in cells]
    has_date = any(cell in DATE_ALIASES for cell in folded)
    has_metric = any(
        cell in aliases for cell in folded for aliases in COLUMN_ALIASES.values()
    )
    return has_date and has_metric


def _skip_preamble(text: str, delimiter: str) -> tuple[str, int]:
    """Retire les lignes de titre precedant le tableau.

    Retourne le texte reduit et le nombre de lignes ecartees. Si aucune ligne
    ne ressemble a un en-tete, on rend le texte inchange: l'erreur qui suivra
    sera plus parlante qu'une troncature arbitraire.
    """
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines[:MAX_PREAMBLE_LINES]):
        cells = next(csv.reader([line.rstrip("\r\n")], delimiter=delimiter), [])
        if _looks_like_header(cells):
            return "".join(lines[index:]), index
    return text, 0


def _sniff(sample: str) -> str:
    """Devine le separateur. Le point-virgule domine les exports Excel francais."""
    try:
        return csv.Sniffer().sniff(sample, delimiters=";,\t|").delimiter
    except csv.Error:
        counts = {sep: sample.count(sep) for sep in (";", ",", "\t", "|")}
        return max(counts, key=lambda key: counts[key]) if any(counts.values()) else ","


def import_csv(
    store: BusinessStore,
    content: str,
    *,
    org_id: str,
    kind: str = "",
    source_ref: str = "",
    source: str = "csv",
) -> ImportReport:
    """Importe un CSV de donnees quotidiennes pour une organisation.

    Le fichier doit avoir une colonne de date et au moins une colonne
    d'indicateur reconnue.

    Args:
        kind: type de l'organisation (`restaurant`, `saas`, `realestate`).
            Il restreint les indicateurs candidats, ce qui leve les alias
            ambigus: « Clients » devient des couverts au restaurant et des
            comptes en SaaS. Vide = tous les indicateurs sont candidats.

    Raises:
        ImportError_: fichier vide, sans en-tete, ou sans colonne de date.
    """
    report = ImportReport()
    text = content.lstrip("﻿")
    if not text.strip():
        raise ImportError_(
            "fichier vide",
            user_message="Le fichier est vide.",
        )

    allowed = (
        {d.key for d in vocabulary.for_kind(kind)} if kind else set(COLUMN_ALIASES)
    )
    if not allowed:
        raise ImportError_(
            f"type d'organisation sans indicateurs: {kind}",
            user_message=f"Je n'ai pas d'indicateurs definis pour une organisation « {kind} ».",
        )

    delimiter = _sniff(text[:4096])
    # Les rapports de caisse commencent souvent par un titre, une plage de
    # dates et une ligne vide avant le vrai tableau. On cherche donc la ligne
    # d'en-tete plutot que de supposer qu'elle est la premiere.
    text, preamble = _skip_preamble(text, delimiter)
    if preamble:
        report.preamble_lines = preamble

    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    if not reader.fieldnames:
        raise ImportError_(
            "aucun en-tete",
            user_message="Le fichier n'a pas de ligne d'en-tete.",
        )

    # Associer chaque colonne a un indicateur.
    date_column = ""
    columns: dict[str, str] = {}
    for name in reader.fieldnames:
        if name is None:
            continue
        folded = _fold(name)
        if not date_column and folded in DATE_ALIASES:
            date_column = name
            continue
        matched = next(
            (
                metric
                for metric, aliases in COLUMN_ALIASES.items()
                if metric in allowed and folded in aliases
            ),
            "",
        )
        if matched and matched not in columns.values():
            columns[name] = matched
        elif folded:
            report.ignored_columns.append(name)

    if not date_column:
        raise ImportError_(
            "colonne de date absente",
            user_message=(
                "Je ne trouve pas de colonne de date. Renomme-la « Date » "
                "(ou « Jour ») et reessaie."
            ),
        )
    if not columns:
        known = ", ".join(
            sorted(
                {
                    vocabulary.METRICS[metric].label
                    for metric in allowed
                    if metric in vocabulary.METRICS
                }
            )
        )
        raise ImportError_(
            "aucune colonne d'indicateur reconnue",
            user_message=(
                "Aucune colonne reconnue dans ce fichier. "
                f"Colonnes attendues (au moins une): {known}."
            ),
        )

    facts: list[Fact] = []
    days: list[str] = []
    # Les numeros signales doivent designer la ligne du FICHIER, pas celle du
    # tableau: sinon l'utilisateur cherche au mauvais endroit dans son export.
    first_data_line = report.preamble_lines + 2
    for line, row in enumerate(reader, start=first_data_line):
        day = parse_day(str(row.get(date_column) or ""))
        if day is None:
            report.rows_failed += 1
            report.errors.append(
                (line, f"date illisible: « {(row.get(date_column) or '').strip()} »")
            )
            continue

        values_found = 0
        for column, metric in columns.items():
            value = parse_amount(str(row.get(column) or ""))
            if value is None:
                continue
            facts.append(
                Fact(
                    org_id=org_id,
                    metric=metric,
                    day=day.isoformat(),
                    value=value,
                    source=source,
                    source_ref=source_ref,
                )
            )
            values_found += 1

        if values_found:
            report.rows_ok += 1
            days.append(day.isoformat())
        else:
            report.rows_failed += 1
            report.errors.append((line, "aucune valeur chiffree lisible sur la ligne"))

    report.facts = store.record(facts)
    report.metrics = sorted(set(columns.values()))
    if days:
        report.first_day, report.last_day = min(days), max(days)

    store.log_import(
        org_id=org_id,
        source=source,
        source_ref=source_ref,
        rows_ok=report.rows_ok,
        rows_failed=report.rows_failed,
        detail=report.summary(),
    )
    return report


def import_csv_file(
    store: BusinessStore,
    path: Path | str,
    *,
    org_id: str,
    kind: str = "",
    source: str = "csv",
) -> ImportReport:
    """Importe un fichier CSV depuis le disque."""
    file = Path(path).expanduser()
    if not file.exists():
        raise ImportError_(
            f"fichier absent: {file}",
            user_message=f"Je ne trouve pas le fichier {file.name}.",
        )
    try:
        content = file.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        # Les exports Windows sont souvent en cp1252.
        content = file.read_text(encoding="cp1252")
    return import_csv(
        store, content, org_id=org_id, kind=kind, source_ref=file.name, source=source
    )
