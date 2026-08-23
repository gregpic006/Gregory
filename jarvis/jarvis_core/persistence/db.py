"""Acces base de donnees (SQLite pour le MVP).

Choix assume: SQLite en M1.  Zero service a installer sous Windows, un fichier
sauvegardable, et un SQL volontairement standard pour pouvoir passer a
PostgreSQL + pgvector en M4 sans reecrire la logique metier.

Les operations sont synchrones: ce sont des ecritures locales de l'ordre de la
milliseconde, negligeables devant un appel LLM ou STT.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


class Database:
    """Connexion SQLite unique, protegee par un verrou."""

    def __init__(self, path: str) -> None:
        self.path = path
        self._lock = threading.RLock()
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")

    @contextmanager
    def cursor(self) -> Iterator[sqlite3.Cursor]:
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        with self.cursor() as cur:
            cur.execute(sql, params)

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def query_one(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def migrate(self) -> list[str]:
        """Applique les migrations non encore appliquees, dans l'ordre."""
        with self.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                " version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            cur.execute("SELECT version FROM schema_migrations")
            applied = {row["version"] for row in cur.fetchall()}

        newly_applied: list[str] = []
        for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
            version = migration.stem
            if version in applied:
                continue
            logger.info("application de la migration %s", version)
            with self._lock:
                try:
                    self._conn.executescript(migration.read_text(encoding="utf-8"))
                    self._conn.execute(
                        "INSERT INTO schema_migrations (version, applied_at) "
                        "VALUES (?, datetime('now'))",
                        (version,),
                    )
                    self._conn.commit()
                except Exception:
                    self._conn.rollback()
                    raise
            newly_applied.append(version)
        return newly_applied

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def build_database(database_url: str) -> Database:
    """Instancie la base a partir de l'URL de configuration."""
    if database_url == "sqlite:///:memory:":
        return Database(":memory:")
    if not database_url.startswith("sqlite:///"):
        raise ValueError(
            f"URL de base non supportee pour l'instant: {database_url}. "
            "Utiliser sqlite:///chemin/vers/jarvis.db"
        )
    return Database(database_url[len("sqlite:///") :])
