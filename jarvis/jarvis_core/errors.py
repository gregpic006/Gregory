"""Hierarchie d'erreurs de JARVIS.

Regle d'or du projet: on ne fabrique jamais une reponse quand une source de
donnees est indisponible.  Chaque erreur porte donc un message destine a
l'utilisateur (`user_message`) que l'orchestrateur peut lire a voix haute tel
quel, sans jamais laisser le modele inventer un resultat.
"""

from __future__ import annotations


class JarvisError(Exception):
    """Erreur de base. `user_message` est safe a lire a voix haute."""

    user_message = "Une erreur est survenue."

    def __init__(self, detail: str = "", user_message: str | None = None) -> None:
        super().__init__(detail or self.user_message)
        self.detail = detail
        if user_message is not None:
            self.user_message = user_message


class ConfigurationError(JarvisError):
    """Configuration manquante ou invalide."""

    user_message = "Ma configuration est incomplete."


class IntegrationNotConfiguredError(JarvisError):
    """Une integration a ete appelee alors qu'elle n'est pas branchee.

    C'est volontairement une erreur bruyante: mieux vaut dire "Gmail n'est pas
    connecte" que de simuler une reponse.
    """

    user_message = "Cette integration n'est pas encore connectee."

    def __init__(self, integration: str, hint: str = "") -> None:
        self.integration = integration
        msg = f"{integration} n'est pas encore connecte."
        if hint:
            msg += f" {hint}"
        super().__init__(detail=f"integration '{integration}' non configuree", user_message=msg)


class IntegrationUnavailableError(JarvisError):
    """L'integration est configuree mais injoignable (reseau, quota, panne)."""

    def __init__(self, integration: str, detail: str = "") -> None:
        self.integration = integration
        super().__init__(
            detail=detail,
            user_message=f"Je n'arrive pas a joindre {integration} pour le moment.",
        )


class ToolNotFoundError(JarvisError):
    user_message = "Je n'ai pas cet outil."


class ToolValidationError(JarvisError):
    """Les parametres fournis par le modele ne respectent pas le schema."""

    user_message = "Je n'ai pas pu executer l'action: parametres invalides."


class PermissionDeniedError(JarvisError):
    user_message = "Je n'ai pas la permission de faire ca."


class ConfirmationRequiredError(JarvisError):
    """Levee quand une action requiert un accord explicite de l'utilisateur."""

    user_message = "J'ai besoin de ta confirmation."


class LLMError(JarvisError):
    user_message = "Mon moteur de raisonnement ne repond pas."


class LLMRefusalError(LLMError):
    user_message = "Je prefere ne pas repondre a ca."


class BudgetExceededError(LLMError):
    user_message = "J'ai atteint le budget quotidien que tu m'as fixe."


class DocumentError(JarvisError):
    """Un document n'a pas pu etre lu, decoupe ou indexe."""

    user_message = "Je n'arrive pas a lire ce document."


class SpeechError(JarvisError):
    user_message = "Probleme avec le systeme vocal."
