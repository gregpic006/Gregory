"""Tests du systeme de permissions.

Ce fichier protege l'invariant le plus important du projet: aucune
configuration ne doit pouvoir auto-approuver une action sensible ou critique.
"""

from __future__ import annotations

import pytest

from jarvis_core.config import Settings
from jarvis_core.errors import ConfigurationError
from jarvis_core.security.permissions import (
    ALLOW,
    CONFIRM,
    DENY,
    PermissionLevel,
    PermissionPolicy,
    policy_from_settings,
)


def test_read_is_allowed_without_confirmation() -> None:
    policy = PermissionPolicy()
    verdict = policy.evaluate("get_calendar_events", PermissionLevel.READ)
    assert verdict.decision == ALLOW


def test_low_write_allowed_under_default_threshold() -> None:
    policy = PermissionPolicy(auto_approve_max_level=PermissionLevel.LOW_WRITE)
    assert policy.evaluate("create_reminder", PermissionLevel.LOW_WRITE).decision == ALLOW


def test_external_communication_requires_confirmation_by_default() -> None:
    policy = PermissionPolicy(auto_approve_max_level=PermissionLevel.LOW_WRITE)
    verdict = policy.evaluate("send_email", PermissionLevel.EXTERNAL_COMM)
    assert verdict.decision == CONFIRM


def test_trusted_recipient_allows_external_communication() -> None:
    policy = PermissionPolicy(
        auto_approve_max_level=PermissionLevel.LOW_WRITE,
        trusted_recipients={"xavier@portail.example"},
    )
    verdict = policy.evaluate(
        "send_email", PermissionLevel.EXTERNAL_COMM, recipients=["Xavier@Portail.example"]
    )
    assert verdict.decision == ALLOW


def test_untrusted_recipient_still_requires_confirmation() -> None:
    policy = PermissionPolicy(trusted_recipients={"xavier@portail.example"})
    verdict = policy.evaluate(
        "send_email",
        PermissionLevel.EXTERNAL_COMM,
        recipients=["xavier@portail.example", "inconnu@example.com"],
    )
    assert verdict.decision == CONFIRM


@pytest.mark.parametrize("level", [PermissionLevel.SENSITIVE, PermissionLevel.CRITICAL])
def test_sensitive_and_critical_are_never_auto_approved(level: PermissionLevel) -> None:
    """Meme avec un seuil d'auto-approbation maximal, ces paliers ne passent pas."""
    policy = PermissionPolicy(auto_approve_max_level=PermissionLevel.CRITICAL)
    verdict = policy.evaluate("dangereux", level)
    assert verdict.decision != ALLOW


def test_critical_is_denied_unless_explicitly_enabled() -> None:
    assert PermissionPolicy().evaluate("bank_transfer", PermissionLevel.CRITICAL).decision == DENY
    permissive = PermissionPolicy(allow_critical=True)
    assert permissive.evaluate("bank_transfer", PermissionLevel.CRITICAL).decision == CONFIRM


def test_tool_override_can_block_a_tool() -> None:
    policy = PermissionPolicy(tool_overrides={"send_email": DENY})
    assert policy.evaluate("send_email", PermissionLevel.EXTERNAL_COMM).decision == DENY


def test_settings_reject_auto_approving_sensitive_levels() -> None:
    """La configuration elle-meme refuse un seuil dangereux."""
    with pytest.raises((ConfigurationError, ValueError)):
        Settings(JARVIS_AUTO_APPROVE_MAX_LEVEL=3)


def test_policy_from_settings_forces_confirmation_on_email() -> None:
    settings = Settings(JARVIS_AUTO_SEND_EMAIL=False, JARVIS_AUTO_APPROVE_MAX_LEVEL=2)
    policy = policy_from_settings(settings)
    assert policy.evaluate("send_email", PermissionLevel.EXTERNAL_COMM).decision == CONFIRM
