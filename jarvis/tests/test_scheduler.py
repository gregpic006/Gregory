"""Planificateur: isolation des pannes et heure locale.

Un briefing qui plante ne doit pas emporter la surveillance des rappels, et
« 7 h » doit vouloir dire 7 h a Quebec, pas 7 h UTC.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from jarvis_core.scheduler import Scheduler, next_daily_run, parse_time_of_day

TZ = ZoneInfo("America/Toronto")


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("7:15", (7, 15)), ("07:15", (7, 15)), ("00:00", (0, 0)), ("23:59", (23, 59))],
)
def test_valid_times_are_read(raw: str, expected: tuple[int, int]) -> None:
    assert parse_time_of_day(raw) == expected


@pytest.mark.parametrize("raw", ["", "25:00", "07:60", "sept heures", "7", "7:15:30", "-1:00"])
def test_invalid_time_is_refused_not_guessed(raw: str) -> None:
    """Une heure illisible desactive la tache; elle ne la declenche pas au hasard."""
    assert parse_time_of_day(raw) is None


def test_daily_run_is_pushed_to_tomorrow_when_the_hour_has_passed() -> None:
    now = datetime(2026, 8, 25, 9, 0, tzinfo=TZ)

    assert next_daily_run(now, 7, 0) == datetime(2026, 8, 26, 7, 0, tzinfo=TZ)
    assert next_daily_run(now, 18, 30) == datetime(2026, 8, 25, 18, 30, tzinfo=TZ)


def test_scheduled_time_is_local_not_utc() -> None:
    """« 7 h » calcule en UTC arriverait a 3 h du matin a Quebec."""
    scheduler = Scheduler("America/Toronto")

    async def noop() -> None:
        return None

    assert scheduler.every_day_at("07:00", name="briefing", handler=noop)
    job = scheduler.jobs[0]

    assert job.next_run is not None
    assert job.next_run.hour == 7
    assert job.next_run.utcoffset() != timedelta(0)


def test_an_unreadable_hour_registers_nothing() -> None:
    scheduler = Scheduler("America/Toronto")

    async def noop() -> None:
        return None

    assert scheduler.every_day_at("pas une heure", name="briefing", handler=noop) is False
    assert scheduler.jobs == []


def test_a_non_positive_interval_registers_nothing() -> None:
    scheduler = Scheduler("America/Toronto")

    async def noop() -> None:
        return None

    assert scheduler.every(0, name="veille", handler=noop) is False
    assert scheduler.jobs == []


async def test_a_failing_job_does_not_stop_the_others() -> None:
    """Un briefing qui plante ne doit pas emporter la surveillance avec lui."""
    scheduler = Scheduler("America/Toronto")
    ran: list[str] = []

    async def boom() -> None:
        raise RuntimeError("panne")

    async def healthy() -> None:
        ran.append("healthy")

    scheduler.every(5, name="qui-plante", handler=boom)
    scheduler.every(5, name="qui-marche", handler=healthy)

    executed = await scheduler.run_due(scheduler.now() + timedelta(minutes=10))

    assert executed == ["qui-plante", "qui-marche"]
    assert ran == ["healthy"]


async def test_a_failure_is_recorded_not_swallowed() -> None:
    scheduler = Scheduler("America/Toronto")

    async def boom() -> None:
        raise RuntimeError("le briefing a echoue")

    scheduler.every(5, name="briefing", handler=boom)
    await scheduler.run_due(scheduler.now() + timedelta(minutes=10))

    job = scheduler.jobs[0]
    assert job.failures == 1
    assert "le briefing a echoue" in job.last_error


async def test_a_job_is_rescheduled_after_running() -> None:
    scheduler = Scheduler("America/Toronto")
    ran: list[int] = []

    async def count() -> None:
        ran.append(1)

    scheduler.every(5, name="veille", handler=count)
    moment = scheduler.now() + timedelta(minutes=10)

    await scheduler.run_due(moment)
    # Immediatement apres, la tache ne doit pas se rejouer.
    await scheduler.run_due(moment)

    assert ran == [1]
    assert scheduler.jobs[0].next_run == moment + timedelta(minutes=5)


async def test_nothing_runs_before_its_time() -> None:
    scheduler = Scheduler("America/Toronto")
    ran: list[int] = []

    async def count() -> None:
        ran.append(1)

    scheduler.every(30, name="veille", handler=count)
    await scheduler.run_due(scheduler.now())

    assert ran == []
