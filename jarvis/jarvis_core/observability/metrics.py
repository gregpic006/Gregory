"""Metriques en memoire.

Volontairement simple (pas de Prometheus au stade MVP) mais deja structure
autour des quatre chiffres qui comptent pour un assistant vocal:

* latence percue (fin de parole -> premier son de reponse);
* cout par jour, par sous-systeme;
* taux d'echec des outils;
* volume d'appels.
"""

from __future__ import annotations

import statistics
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class LatencyWindow:
    """Fenetre glissante de mesures de latence."""

    maxlen: int = 200
    samples: deque[float] = field(default_factory=lambda: deque(maxlen=200))

    def add(self, value_ms: float) -> None:
        self.samples.append(value_ms)

    def summary(self) -> dict[str, float]:
        if not self.samples:
            return {"count": 0, "p50": 0.0, "p95": 0.0, "avg": 0.0}
        ordered = sorted(self.samples)
        index_95 = max(0, int(len(ordered) * 0.95) - 1)
        return {
            "count": len(ordered),
            "p50": round(statistics.median(ordered), 1),
            "p95": round(ordered[index_95], 1),
            "avg": round(statistics.fmean(ordered), 1),
        }


class Metrics:
    """Collecteur de metriques du processus."""

    def __init__(self) -> None:
        self.started_at = time.time()
        self.turn_latency = LatencyWindow()
        self.stt_latency = LatencyWindow()
        self.tts_latency = LatencyWindow()
        self.llm_latency = LatencyWindow()
        self.tool_calls: dict[str, int] = defaultdict(int)
        self.tool_failures: dict[str, int] = defaultdict(int)
        self.turns = 0
        self.errors = 0

    def record_turn(self, latency_ms: float) -> None:
        self.turns += 1
        self.turn_latency.add(latency_ms)

    def record_tool(self, name: str, *, ok: bool) -> None:
        self.tool_calls[name] += 1
        if not ok:
            self.tool_failures[name] += 1

    def record_error(self) -> None:
        self.errors += 1

    def tool_failure_rate(self) -> float:
        total = sum(self.tool_calls.values())
        if not total:
            return 0.0
        return round(sum(self.tool_failures.values()) / total, 3)

    def snapshot(self, spend: dict[str, Any] | None = None) -> dict[str, Any]:
        return {
            "uptime_seconds": int(time.time() - self.started_at),
            "turns": self.turns,
            "errors": self.errors,
            "latency_ms": {
                "turn": self.turn_latency.summary(),
                "stt": self.stt_latency.summary(),
                "tts": self.tts_latency.summary(),
                "llm": self.llm_latency.summary(),
            },
            "tools": {
                "calls": dict(self.tool_calls),
                "failures": dict(self.tool_failures),
                "failure_rate": self.tool_failure_rate(),
            },
            "llm_spend": spend or {},
        }
