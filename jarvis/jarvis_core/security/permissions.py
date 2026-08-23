"""Systeme de permissions a paliers.

Chaque outil declare son palier.  L'orchestrateur consulte la `PermissionPolicy`
AVANT toute execution.  Trois resultats possibles: ALLOW, CONFIRM, DENY.

Invariant non negociable: les paliers SENSITIVE (3) et CRITICAL (4) ne peuvent
jamais etre auto-approuves par configuration - ils exigent une confirmation
humaine explicite.  CRITICAL est refuse par defaut tant qu'il n'est pas
explicitement autorise dans la politique.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import IntEnum


class PermissionLevel(IntEnum):
    """Paliers de risque, du plus benin au plus dangereux."""

    READ = 0
    """Lecture seule: calendrier, courriels, ventes, fichiers, calculs."""

    LOW_WRITE = 1
    """Ecriture locale sans effet exterieur: note, rappel, brouillon."""

    EXTERNAL_COMM = 2
    """Communication sortante: envoi de courriel, message, reponse."""

    SENSITIVE = 3
    """Effet destructif ou financier: suppression, annulation, modification business."""

    CRITICAL = 4
    """Irreversible: virement bancaire, suppression massive, changement de permissions."""

    @property
    def label(self) -> str:
        return {
            PermissionLevel.READ: "lecture",
            PermissionLevel.LOW_WRITE: "ecriture locale",
            PermissionLevel.EXTERNAL_COMM: "communication externe",
            PermissionLevel.SENSITIVE: "action sensible",
            PermissionLevel.CRITICAL: "action critique",
        }[self]


ALLOW = "allow"
CONFIRM = "confirm"
DENY = "deny"

#: Les paliers 3 et 4 ne peuvent jamais etre auto-approuves, quelle que soit
#: la configuration.  Constante utilisee aussi par les tests de securite.
NEVER_AUTO_APPROVED = frozenset({PermissionLevel.SENSITIVE, PermissionLevel.CRITICAL})


@dataclass(frozen=True)
class PermissionVerdict:
    """Resultat d'une evaluation de permission."""

    decision: str
    level: PermissionLevel
    reason: str

    @property
    def allowed(self) -> bool:
        return self.decision == ALLOW

    @property
    def needs_confirmation(self) -> bool:
        return self.decision == CONFIRM

    @property
    def denied(self) -> bool:
        return self.decision == DENY


@dataclass
class PermissionPolicy:
    """Politique de permissions de l'utilisateur.

    Args:
        auto_approve_max_level: palier maximum execute sans confirmation.
            Plafonne a `LOW_WRITE` par securite via `Settings`.
        allow_critical: autorise l'evaluation des actions palier 4.  Faux par
            defaut: elles sont refusees, pas seulement confirmees.
        trusted_recipients: destinataires pour lesquels une communication
            sortante (palier 2) peut etre auto-approuvee.
        tool_overrides: exceptions nommees, `{"send_email": CONFIRM}`.
    """

    auto_approve_max_level: PermissionLevel = PermissionLevel.LOW_WRITE
    allow_critical: bool = False
    trusted_recipients: set[str] = field(default_factory=set)
    tool_overrides: dict[str, str] = field(default_factory=dict)

    def evaluate(
        self,
        tool_name: str,
        level: PermissionLevel,
        *,
        recipients: list[str] | None = None,
    ) -> PermissionVerdict:
        """Decide si `tool_name` peut s'executer maintenant."""
        override = self.tool_overrides.get(tool_name)
        if override == DENY:
            return PermissionVerdict(DENY, level, f"'{tool_name}' est bloque par ta politique.")

        if level >= PermissionLevel.CRITICAL and not self.allow_critical:
            return PermissionVerdict(
                DENY,
                level,
                "Action critique: refusee tant qu'elle n'est pas explicitement autorisee.",
            )

        if override == CONFIRM:
            return PermissionVerdict(CONFIRM, level, f"'{tool_name}' exige une confirmation.")

        if level in NEVER_AUTO_APPROVED:
            return PermissionVerdict(
                CONFIRM, level, f"Action {level.label}: confirmation obligatoire."
            )

        if override == ALLOW:
            return PermissionVerdict(ALLOW, level, f"'{tool_name}' est pre-autorise.")

        if level == PermissionLevel.EXTERNAL_COMM and recipients:
            normalized = {r.strip().lower() for r in recipients if r.strip()}
            if normalized and normalized.issubset(self.trusted_recipients):
                return PermissionVerdict(
                    ALLOW, level, "Destinataires de confiance."
                )

        if level <= self.auto_approve_max_level:
            return PermissionVerdict(ALLOW, level, "Sous le seuil d'auto-approbation.")

        return PermissionVerdict(CONFIRM, level, f"Action {level.label}: je demande avant.")


def policy_from_settings(settings: object) -> PermissionPolicy:
    """Construit la politique a partir de la configuration applicative."""
    max_level = PermissionLevel(getattr(settings, "auto_approve_max_level", 1))
    overrides: dict[str, str] = {}
    if not getattr(settings, "auto_send_email", False):
        overrides["send_email"] = CONFIRM
    return PermissionPolicy(auto_approve_max_level=max_level, tool_overrides=overrides)
