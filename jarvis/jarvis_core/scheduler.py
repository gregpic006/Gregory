"""Planificateur de taches recurrentes.

Ecrit a la main plutot que d'ajouter une dependance: on a besoin de deux
choses — « tous les jours a 7 h 15 » et « toutes les N minutes » — et une
librairie complete ferait entrer un ordonnanceur, un magasin de jobs et un
systeme d'evenements pour ca.

Deux garanties structurent le module.

**Une tache qui echoue n'arrete jamais le planificateur.** Un briefing qui
plante ne doit pas emporter la surveillance des rappels avec lui.

**L'heure est celle de l'utilisateur.** Un briefing « a 7 h » calcule en UTC
arriverait a 3 h du matin a Quebec. Tout passe par le fuseau configure.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from jarvis_core.timeutils import get_tz

logger = logging.getLogger(__name__)

JobHandler = Callable[[], Awaitable[None]]

#: Marge de tolerance: si le reveil arrive avec quelques secondes de retard, on
#: considere quand meme que l'heure est passee plutot que d'attendre 24 h.
TICK_SECONDS = 20.0


@dataclass
class Job:
    """Une tache planifiee."""

    name: str
    handler: JobHandler
    daily_at: str = ""
    """Heure locale « HH:MM ». Exclusif avec `every_minutes`."""
    every_minutes: int = 0
    next_run: datetime | None = None
    last_run: datetime | None = None
    last_error: str = ""
    runs: int = 0
    failures: int = 0

    def describe(self) -> dict[str, object]:
        return {
            "name": self.name,
            "schedule": self.daily_at or f"toutes les {self.every_minutes} min",
            "next_run": self.next_run.isoformat() if self.next_run else "",
            "last_run": self.last_run.isoformat() if self.last_run else "",
            "runs": self.runs,
            "failures": self.failures,
            "last_error": self.last_error,
        }


def parse_time_of_day(value: str) -> tuple[int, int] | None:
    """Lit « 7:15 » ou « 07:15 ». Retourne None si c'est illisible.

    On ne devine pas: une heure mal ecrite doit desactiver la tache avec un
    message, pas la declencher a un moment arbitraire.
    """
    text = value.strip()
    if not text:
        return None
    parts = text.split(":")
    if len(parts) != 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour, minute


def next_daily_run(now: datetime, hour: int, minute: int) -> datetime:
    """Prochaine occurrence de HH:MM, aujourd'hui ou demain."""
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


class Scheduler:
    """Execute des taches a heure fixe ou a intervalle regulier."""

    def __init__(self, timezone: str) -> None:
        self.timezone = timezone
        self._jobs: list[Job] = []
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    def now(self) -> datetime:
        return datetime.now(get_tz(self.timezone))

    @property
    def jobs(self) -> list[Job]:
        return list(self._jobs)

    def every_day_at(self, time_of_day: str, *, name: str, handler: JobHandler) -> bool:
        """Planifie une tache quotidienne. Retourne False si l'heure est illisible."""
        parsed = parse_time_of_day(time_of_day)
        if parsed is None:
            logger.warning("heure invalide pour la tache '%s': %r", name, time_of_day)
            return False
        hour, minute = parsed
        job = Job(name=name, handler=handler, daily_at=f"{hour:02d}:{minute:02d}")
        job.next_run = next_daily_run(self.now(), hour, minute)
        self._jobs.append(job)
        logger.info("tache '%s' planifiee a %s (%s)", name, job.daily_at, self.timezone)
        return True

    def every(self, minutes: int, *, name: str, handler: JobHandler) -> bool:
        """Planifie une tache periodique."""
        if minutes <= 0:
            logger.warning("intervalle invalide pour la tache '%s': %s", name, minutes)
            return False
        job = Job(name=name, handler=handler, every_minutes=minutes)
        job.next_run = self.now() + timedelta(minutes=minutes)
        self._jobs.append(job)
        logger.info("tache '%s' planifiee toutes les %s min", name, minutes)
        return True

    async def run_due(self, moment: datetime | None = None) -> list[str]:
        """Execute les taches echues. Retourne les noms de celles qui ont tourne.

        Extraite de la boucle pour etre testable sans attendre l'horloge.
        """
        current = moment or self.now()
        executed: list[str] = []
        for job in self._jobs:
            if job.next_run is None or current < job.next_run:
                continue
            executed.append(job.name)
            try:
                await job.handler()
                job.last_error = ""
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - une tache ne doit rien emporter
                job.failures += 1
                job.last_error = str(exc)[:200]
                logger.warning("tache '%s' en echec: %s", job.name, exc)
            finally:
                job.runs += 1
                job.last_run = current
                job.next_run = self._reschedule(job, current)
        return executed

    def _reschedule(self, job: Job, current: datetime) -> datetime:
        if job.daily_at:
            hour, minute = (int(part) for part in job.daily_at.split(":"))
            return next_daily_run(current, hour, minute)
        return current + timedelta(minutes=job.every_minutes)

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.run_due()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - la boucle survit a tout
                logger.warning("erreur du planificateur: %s", exc)
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=TICK_SECONDS)
            except TimeoutError:
                continue

    def start(self) -> None:
        if self._task is not None or not self._jobs:
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop(), name="jarvis-scheduler")
        logger.info("planificateur demarre (%s tache(s))", len(self._jobs))

    async def stop(self) -> None:
        self._stopping.set()
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        # L'arret est « best effort »: une tache qui refuse de mourir proprement
        # ne doit pas empecher le serveur de s'eteindre.
        with contextlib.suppress(Exception):
            await task

    def status(self) -> list[dict[str, object]]:
        return [job.describe() for job in self._jobs]
