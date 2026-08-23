"""Stockage des jetons OAuth, chiffres au repos.

Le chiffrement a lieu ici, au plus pres de la base: aucune couche superieure
ne manipule un jeton chiffre, et la table ne contient jamais de clair.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from jarvis_core.persistence.db import Database
from jarvis_core.security.crypto import SecretBox


@dataclass
class StoredToken:
    """Jeton OAuth dechiffre, tel qu'utilise par le code applicatif."""

    provider: str
    account: str
    access_token: str
    refresh_token: str
    token_type: str
    scopes: list[str]
    expires_at: datetime

    def is_expired(self, *, leeway_seconds: int = 60) -> bool:
        """Vrai si le jeton est expire ou sur le point de l'etre.

        La marge evite de partir en requete avec un jeton qui expirera pendant
        le trajet reseau.
        """
        return datetime.now(UTC) >= self.expires_at - timedelta(seconds=leeway_seconds)

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes

    def as_public_dict(self) -> dict[str, Any]:
        """Vue sans secret, exposable a l'interface."""
        return {
            "provider": self.provider,
            "account": self.account,
            "scopes": self.scopes,
            "expires_at": self.expires_at.isoformat(),
            "expired": self.is_expired(leeway_seconds=0),
        }


class OAuthTokenRepository:
    """Lecture/ecriture des jetons, avec chiffrement transparent."""

    def __init__(self, db: Database, secret_box: SecretBox) -> None:
        self.db = db
        self.box = secret_box

    def save(
        self,
        *,
        provider: str,
        account: str,
        access_token: str,
        refresh_token: str,
        token_type: str,
        scopes: list[str],
        expires_at: datetime,
    ) -> StoredToken:
        """Enregistre ou remplace le jeton d'un compte."""
        now_iso = datetime.now(UTC).isoformat()
        existing = self.db.query_one(
            "SELECT id, refresh_token FROM oauth_tokens WHERE provider = ? AND account = ?",
            (provider, account),
        )
        # Google n'emet un refresh_token qu'au premier consentement: on conserve
        # celui deja stocke si le rafraichissement n'en renvoie pas de nouveau.
        encrypted_refresh = (
            self.box.encrypt(refresh_token)
            if refresh_token
            else (existing["refresh_token"] if existing else "")
        )
        record_id = existing["id"] if existing else f"o_{uuid.uuid4().hex[:12]}"
        self.db.execute(
            "INSERT INTO oauth_tokens (id, provider, account, access_token, refresh_token,"
            " token_type, scopes, expires_at, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)"
            " ON CONFLICT(provider, account) DO UPDATE SET"
            "  access_token = excluded.access_token,"
            "  refresh_token = excluded.refresh_token,"
            "  token_type = excluded.token_type,"
            "  scopes = excluded.scopes,"
            "  expires_at = excluded.expires_at,"
            "  updated_at = excluded.updated_at",
            (
                record_id,
                provider,
                account,
                self.box.encrypt(access_token),
                encrypted_refresh,
                token_type,
                " ".join(scopes),
                expires_at.isoformat(),
                now_iso,
                now_iso,
            ),
        )
        return StoredToken(
            provider=provider,
            account=account,
            access_token=access_token,
            refresh_token=refresh_token,
            token_type=token_type,
            scopes=scopes,
            expires_at=expires_at,
        )

    def get(self, provider: str, account: str | None = None) -> StoredToken | None:
        """Retourne le jeton d'un compte, ou le plus recent du fournisseur."""
        if account:
            row = self.db.query_one(
                "SELECT * FROM oauth_tokens WHERE provider = ? AND account = ?",
                (provider, account),
            )
        else:
            row = self.db.query_one(
                "SELECT * FROM oauth_tokens WHERE provider = ? ORDER BY updated_at DESC LIMIT 1",
                (provider,),
            )
        if row is None:
            return None
        return StoredToken(
            provider=row["provider"],
            account=row["account"],
            access_token=self.box.decrypt(row["access_token"]),
            refresh_token=self.box.decrypt(row["refresh_token"]) if row["refresh_token"] else "",
            token_type=row["token_type"],
            scopes=row["scopes"].split() if row["scopes"] else [],
            expires_at=datetime.fromisoformat(row["expires_at"]),
        )

    def list_accounts(self, provider: str) -> list[str]:
        rows = self.db.query(
            "SELECT account FROM oauth_tokens WHERE provider = ? ORDER BY account", (provider,)
        )
        return [row["account"] for row in rows]

    def delete(self, provider: str, account: str | None = None) -> int:
        """Supprime les jetons; retourne le nombre de comptes deconnectes."""
        accounts = [account] if account else self.list_accounts(provider)
        for item in accounts:
            self.db.execute(
                "DELETE FROM oauth_tokens WHERE provider = ? AND account = ?", (provider, item)
            )
        return len(accounts)
