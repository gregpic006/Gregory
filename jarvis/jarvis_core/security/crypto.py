"""Chiffrement au repos des secrets d'integration (tokens OAuth, cles tierces).

Les jetons OAuth ne sont jamais stockes en clair.  La cle vient de
`JARVIS_ENCRYPTION_KEY` (Fernet, base64, 32 octets).  En developpement, si la
cle est absente, une cle ephemere est generee en memoire: les jetons stockes
deviennent illisibles au redemarrage, ce qui est le comportement voulu (mieux
qu'un stockage en clair silencieux).
"""

from __future__ import annotations

import logging

from cryptography.fernet import Fernet, InvalidToken

from jarvis_core.errors import ConfigurationError

logger = logging.getLogger(__name__)


class SecretBox:
    """Chiffre/dechiffre des chaines courtes (jetons, cles)."""

    def __init__(self, key: str, *, allow_ephemeral: bool = False) -> None:
        if key:
            try:
                self._fernet = Fernet(key.encode())
            except (ValueError, TypeError) as exc:
                raise ConfigurationError(
                    "JARVIS_ENCRYPTION_KEY invalide. Generer avec: "
                    'python -c "from cryptography.fernet import Fernet; '
                    'print(Fernet.generate_key().decode())"'
                ) from exc
            self.ephemeral = False
        elif allow_ephemeral:
            logger.warning(
                "JARVIS_ENCRYPTION_KEY absente: cle ephemere generee. "
                "Les jetons chiffres seront illisibles au prochain demarrage."
            )
            self._fernet = Fernet(Fernet.generate_key())
            self.ephemeral = True
        else:
            raise ConfigurationError(
                "JARVIS_ENCRYPTION_KEY est requise en production."
            )

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode()).decode()

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self._fernet.decrypt(ciphertext.encode()).decode()
        except InvalidToken as exc:
            raise ConfigurationError(
                "Jeton impossible a dechiffrer (cle changee ou donnee corrompue). "
                "Reconnecte l'integration concernee."
            ) from exc

    @staticmethod
    def generate_key() -> str:
        """Genere une cle Fernet a coller dans `.env`."""
        return Fernet.generate_key().decode()
