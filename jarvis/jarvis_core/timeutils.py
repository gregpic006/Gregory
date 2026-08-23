"""Gestion du temps et des expressions temporelles en francais.

Regle du projet: le LLM ne calcule JAMAIS de dates lui-meme.  Il appelle
`resolve_date_expression` via un outil, ou recoit deja la date resolue dans son
contexte.  Tous les calculs passent par `zoneinfo` et `dateutil`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil.relativedelta import MO, relativedelta

from jarvis_core.errors import ConfigurationError

_WEEKDAYS = {
    "lundi": 0,
    "mardi": 1,
    "mercredi": 2,
    "jeudi": 3,
    "vendredi": 4,
    "samedi": 5,
    "dimanche": 6,
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}

_MONTHS_FR = [
    "janvier", "fevrier", "mars", "avril", "mai", "juin",
    "juillet", "aout", "septembre", "octobre", "novembre", "decembre",
]
_DAYS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]


def get_tz(timezone: str) -> ZoneInfo:
    """Charge un fuseau IANA.

    Windows n'embarque aucune base de fuseaux: `zoneinfo` se rabat sur le
    paquet `tzdata`. S'il manque, TOUS les fuseaux echouent, pas seulement
    celui demande - on distingue les deux cas pour donner la bonne consigne.
    """
    try:
        return ZoneInfo(timezone)
    except ZoneInfoNotFoundError as exc:
        if _tzdata_missing():
            raise ConfigurationError(
                f"base de fuseaux horaires absente (demande: {timezone})",
                user_message=(
                    "La base de fuseaux horaires manque sur cette machine. "
                    "Installe-la: pip install tzdata"
                ),
            ) from exc
        raise ConfigurationError(
            f"fuseau horaire inconnu: {timezone}",
            user_message=(
                f"Le fuseau horaire '{timezone}' n'existe pas. Corrige "
                "JARVIS_TIMEZONE dans .env (par exemple America/Montreal)."
            ),
        ) from exc


def _tzdata_missing() -> bool:
    """Vrai si aucune base de fuseaux n'est disponible sur le systeme."""
    try:
        ZoneInfo("UTC")
    except ZoneInfoNotFoundError:
        return True
    return False


def now(timezone: str) -> datetime:
    """Heure courante dans le fuseau de l'utilisateur."""
    return datetime.now(get_tz(timezone))


@dataclass(frozen=True)
class TimeRange:
    """Intervalle [start, end) toujours conscient du fuseau horaire."""

    start: datetime
    end: datetime
    label: str

    def as_dict(self) -> dict[str, str]:
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "label": self.label,
        }


def _day_range(day: date, tz: ZoneInfo, label: str) -> TimeRange:
    start = datetime.combine(day, time.min, tzinfo=tz)
    return TimeRange(start=start, end=start + timedelta(days=1), label=label)


def _strip_accents(text: str) -> str:
    table = str.maketrans("àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ", "aaaeeeeiioouuucAAAEEEEIIOOUUUC")
    return text.translate(table)


def resolve_date_expression(
    expression: str, timezone: str, *, reference: datetime | None = None
) -> TimeRange:
    """Transforme une expression francaise/anglaise en intervalle concret.

    Exemples supportes: `aujourd'hui`, `demain`, `apres-demain`, `hier`,
    `ce soir`, `ce matin`, `cette semaine`, `la semaine prochaine`,
    `la semaine passee`, `ce mois-ci`, `le mois dernier`, `vendredi prochain`,
    `dans 3 jours`, `2026-08-23`.

    Leve `ValueError` si l'expression n'est pas reconnue - on prefere demander
    une precision plutot que de deviner.
    """
    tz = get_tz(timezone)
    ref = (reference or datetime.now(tz)).astimezone(tz)
    today = ref.date()
    raw = _strip_accents(expression.strip().lower())
    raw = re.sub(r"\s+", " ", raw).strip(" ?.!")

    # Date ISO explicite
    iso = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if iso:
        day = date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
        return _day_range(day, tz, day.isoformat())

    simple: dict[str, tuple[int, str]] = {
        "aujourd'hui": (0, "aujourd'hui"),
        "aujourdhui": (0, "aujourd'hui"),
        "today": (0, "aujourd'hui"),
        "demain": (1, "demain"),
        "tomorrow": (1, "demain"),
        "apres-demain": (2, "apres-demain"),
        "apres demain": (2, "apres-demain"),
        "hier": (-1, "hier"),
        "yesterday": (-1, "hier"),
        "avant-hier": (-2, "avant-hier"),
        "avant hier": (-2, "avant-hier"),
    }
    if raw in simple:
        offset, label = simple[raw]
        return _day_range(today + timedelta(days=offset), tz, label)

    # Moments de la journee
    parts_of_day: dict[str, tuple[int, int, int, str]] = {
        "ce matin": (0, 5, 12, "ce matin"),
        "cet apres-midi": (0, 12, 18, "cet apres-midi"),
        "ce soir": (0, 17, 23, "ce soir"),
        "cette nuit": (0, 22, 23, "cette nuit"),
        "demain matin": (1, 5, 12, "demain matin"),
        "demain apres-midi": (1, 12, 18, "demain apres-midi"),
        "demain soir": (1, 17, 23, "demain soir"),
    }
    if raw in parts_of_day:
        offset, h_start, h_end, label = parts_of_day[raw]
        day = today + timedelta(days=offset)
        start = datetime.combine(day, time(hour=h_start), tzinfo=tz)
        end = datetime.combine(day, time(hour=h_end, minute=59, second=59), tzinfo=tz)
        return TimeRange(start=start, end=end, label=label)

    # Semaines
    week_start = today - timedelta(days=today.weekday())
    if raw in {"cette semaine", "this week"}:
        start = datetime.combine(week_start, time.min, tzinfo=tz)
        return TimeRange(start, start + timedelta(days=7), "cette semaine")
    if raw in {"la semaine prochaine", "semaine prochaine", "next week"}:
        start = datetime.combine(week_start + timedelta(days=7), time.min, tzinfo=tz)
        return TimeRange(start, start + timedelta(days=7), "la semaine prochaine")
    if raw in {
        "la semaine passee", "semaine passee", "la semaine derniere", "last week",
    }:
        start = datetime.combine(week_start - timedelta(days=7), time.min, tzinfo=tz)
        return TimeRange(start, start + timedelta(days=7), "la semaine passee")

    # Mois
    if raw in {"ce mois-ci", "ce mois", "this month"}:
        start = datetime.combine(today.replace(day=1), time.min, tzinfo=tz)
        return TimeRange(start, start + relativedelta(months=1), "ce mois-ci")
    if raw in {"le mois dernier", "mois dernier", "le mois passe", "last month"}:
        start = datetime.combine(
            today.replace(day=1) - relativedelta(months=1), time.min, tzinfo=tz
        )
        return TimeRange(start, start + relativedelta(months=1), "le mois dernier")

    # `dans N jours/heures/semaines`
    rel = re.fullmatch(r"dans (\d+) (minutes?|heures?|jours?|semaines?|mois)", raw)
    if rel:
        amount = int(rel.group(1))
        unit = rel.group(2)
        if unit.startswith("minute"):
            start = ref + timedelta(minutes=amount)
            return TimeRange(start, start + timedelta(minutes=1), raw)
        if unit.startswith("heure"):
            start = ref + timedelta(hours=amount)
            return TimeRange(start, start + timedelta(hours=1), raw)
        if unit.startswith("jour"):
            return _day_range(today + timedelta(days=amount), tz, raw)
        if unit.startswith("semaine"):
            start = datetime.combine(today + timedelta(weeks=amount), time.min, tzinfo=tz)
            return TimeRange(start, start + timedelta(days=1), raw)
        start = datetime.combine(today + relativedelta(months=amount), time.min, tzinfo=tz)
        return TimeRange(start, start + timedelta(days=1), raw)

    # Jours de la semaine, avec ou sans `prochain` / `dernier`
    weekday_match = re.fullmatch(
        r"(?:le )?(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|"
        r"wednesday|thursday|friday|saturday|sunday)( prochain| dernier| passe)?",
        raw,
    )
    if weekday_match:
        target = _WEEKDAYS[weekday_match.group(1)]
        qualifier = (weekday_match.group(2) or "").strip()
        if qualifier in {"dernier", "passe"}:
            day = today + relativedelta(weekday=MO(-1))
            day = day + timedelta(days=target - day.weekday())
            if day >= today:
                day -= timedelta(days=7)
        else:
            # Sans qualificatif: la prochaine occurrence (jamais aujourd'hui).
            delta = (target - today.weekday()) % 7 or 7
            day = today + timedelta(days=delta)
            # "vendredi prochain" est ambigu a l'oral. Convention retenue et
            # documentee: la semaine SUIVANTE, coherente avec "la semaine
            # prochaine". Si l'occurrence tombe dans la semaine courante, on
            # ajoute sept jours.
            if qualifier == "prochain" and day.isocalendar()[:2] == today.isocalendar()[:2]:
                day += timedelta(days=7)
        return _day_range(day, tz, raw)

    raise ValueError(f"Expression temporelle non reconnue: {expression!r}")


def format_datetime_fr(value: datetime, timezone: str) -> str:
    """Formate une date/heure en francais quebecois lisible a voix haute."""
    local = value.astimezone(get_tz(timezone))
    jour = _DAYS_FR[local.weekday()]
    mois = _MONTHS_FR[local.month - 1]
    heure = f"{local.hour} h" if local.minute == 0 else f"{local.hour} h {local.minute:02d}"
    return f"{jour} {local.day} {mois} {local.year}, {heure}"


def describe_now(timezone: str) -> dict[str, str]:
    """Bloc temporel injecte dans le contexte du modele a chaque tour."""
    current = now(timezone)
    return {
        "iso": current.isoformat(),
        "timezone": timezone,
        "human": format_datetime_fr(current, timezone),
        "weekday": _DAYS_FR[current.weekday()],
        "date": current.date().isoformat(),
    }
