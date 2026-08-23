"""Configuration de journalisation.

Les logs ne doivent jamais contenir de secret: un filtre masque les motifs
ressemblant a des cles avant ecriture.
"""

from __future__ import annotations

import logging
import sys

from jarvis_core.security.sanitize import redact_secrets


class RedactingFilter(logging.Filter):
    """Masque les secrets dans les messages journalises."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_secrets(record.msg)
        if record.args:
            record.args = tuple(
                redact_secrets(arg) if isinstance(arg, str) else arg for arg in record.args
            )
        return True


def setup_logging(level: str = "INFO") -> None:
    """Installe le formatage et le filtre de redaction."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)-7s %(name)s | %(message)s", "%H:%M:%S")
    )
    handler.addFilter(RedactingFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Uvicorn duplique les logs d'acces: on les garde mais sans doublon de handler.
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True
