"""L'orchestrateur: le coeur de JARVIS.

Sequence d'un tour:

    transcription -> contexte -> LLM -> outils (avec permissions) -> reponse -> TTS

Responsabilites concentrees ici (et nulle part ailleurs):

* choisir le niveau de modele (cout / latence);
* exposer les bons outils selon les feature flags;
* faire respecter les permissions AVANT execution;
* encapsuler tout contenu externe avant de le montrer au modele;
* journaliser chaque appel dans la piste d'audit;
* ne jamais laisser passer une reponse inventee quand un outil a echoue.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from jarvis_core.config import Settings
from jarvis_core.errors import (
    ConfigurationError,
    IntegrationNotConfiguredError,
    IntegrationUnavailableError,
    JarvisError,
    LLMError,
    ToolValidationError,
)
from jarvis_core.llm.base import LLMMessage, TaskTier, ToolCall, ToolResultBlock
from jarvis_core.llm.router import LLMRouter
from jarvis_core.memory.session import PendingAction, SessionMemory
from jarvis_core.memory.store import MemoryStore
from jarvis_core.orchestrator.events import EventSink, JarvisEvent, State, noop_sink
from jarvis_core.orchestrator.prompt import build_system_prompt
from jarvis_core.persistence.repositories import ReminderRepository
from jarvis_core.security.audit import AuditTrail
from jarvis_core.security.permissions import PermissionPolicy, PermissionVerdict
from jarvis_core.security.sanitize import wrap_external_content
from jarvis_core.tools.base import Citation, ToolContext, ToolResult
from jarvis_core.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

#: Garde-fou contre les boucles d'outils infinies.
MAX_TOOL_ITERATIONS = 6

#: Prefixe reserve aux messages injectes par le runtime (jamais par une source
#: externe).  Le modele est instruit de les traiter comme des faits systeme.
RUNTIME_PREFIX = "[SYSTEME JARVIS]"

_AFFIRMATIONS = re.compile(
    r"^\s*(oui|ouais|yes|yep|ok|okay|c'est bon|vas[- ]y|envoie|envoie[- ]le|confirme|"
    r"confirmer|fais[- ]le|go|parfait|exact|correct)\b",
    re.IGNORECASE,
)
_NEGATIONS = re.compile(
    r"^\s*(non|nope|no|annule|annuler|laisse|laisse faire|oublie|stop|attends|pas tout de suite)\b",
    re.IGNORECASE,
)
_SIMPLE_TURN = re.compile(
    r"^\s*(bon matin|bonjour|bonsoir|bonne nuit|salut|allo|hey|hello|good morning|"
    r"good evening|merci|thanks|ca va|comment ca va|t'es la|tu es la|are you there)\b",
    re.IGNORECASE,
)


@dataclass
class ExecutedTool:
    """Trace d'un outil execute pendant le tour."""

    name: str
    ok: bool
    summary: str
    data: dict[str, Any] = field(default_factory=dict)
    decision: str = "allow"


@dataclass
class TurnResult:
    """Resultat complet d'un tour de conversation."""

    text: str
    session_id: str
    citations: list[Citation] = field(default_factory=list)
    tools: list[ExecutedTool] = field(default_factory=list)
    pending_confirmation: dict[str, Any] | None = None
    latency_ms: int = 0
    model: str = ""
    error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "session_id": self.session_id,
            "citations": [c.as_dict() for c in self.citations],
            "tools": [
                {"name": t.name, "ok": t.ok, "summary": t.summary, "decision": t.decision}
                for t in self.tools
            ],
            "pending_confirmation": self.pending_confirmation,
            "latency_ms": self.latency_ms,
            "model": self.model,
            "error": self.error,
        }


class JarvisOrchestrator:
    """Assemble tous les sous-systemes pour produire une reponse."""

    def __init__(
        self,
        *,
        settings: Settings,
        router: LLMRouter,
        registry: ToolRegistry,
        policy: PermissionPolicy,
        audit: AuditTrail,
        memory_store: MemoryStore | None = None,
        reminders: ReminderRepository | None = None,
    ) -> None:
        self.settings = settings
        self.router = router
        self.registry = registry
        self.policy = policy
        self.audit = audit
        self.memory_store = memory_store
        self.reminders = reminders

    # -- point d'entree ------------------------------------------------------

    async def handle_text(
        self,
        session: SessionMemory,
        text: str,
        *,
        sink: EventSink | None = None,
        cancel: asyncio.Event | None = None,
    ) -> TurnResult:
        """Traite un tour de conversation en mode texte ou vocal."""
        emit = sink or noop_sink
        started = time.perf_counter()
        user_text = text.strip()
        if not user_text:
            return TurnResult(text="", session_id=session.session_id)

        # Reponse a une demande de confirmation en cours.
        if session.pending:
            resolved = await self._maybe_resolve_confirmation(session, user_text, emit)
            if resolved is not None:
                resolved.latency_ms = int((time.perf_counter() - started) * 1000)
                return resolved

        await emit(JarvisEvent.state(State.UNDERSTANDING))
        session.add_user_text(user_text)

        try:
            result = await self._run_turn(session, user_text, emit, cancel)
        except LLMError as exc:
            logger.warning("echec LLM: %s", exc.detail or exc)
            await emit(JarvisEvent.error(exc.user_message, code="llm_error"))
            session.add_assistant(exc.user_message)
            return TurnResult(
                text=exc.user_message,
                session_id=session.session_id,
                error=str(exc.detail or exc),
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
        except JarvisError as exc:
            logger.warning("erreur de tour: %s", exc.detail or exc)
            await emit(JarvisEvent.error(exc.user_message, code="jarvis_error"))
            return TurnResult(
                text=exc.user_message,
                session_id=session.session_id,
                error=str(exc.detail or exc),
                latency_ms=int((time.perf_counter() - started) * 1000),
            )

        result.latency_ms = int((time.perf_counter() - started) * 1000)
        await emit(
            JarvisEvent.metrics(
                {"latency_ms": result.latency_ms, "spend": self.router.spend.snapshot()}
            )
        )
        return result

    # -- boucle principale ---------------------------------------------------

    async def _run_turn(
        self,
        session: SessionMemory,
        user_text: str,
        emit: EventSink,
        cancel: asyncio.Event | None,
    ) -> TurnResult:
        tier = self._select_tier(user_text)
        features = self.settings.feature_map()
        tool_specs = self.registry.specs(features)
        executed: list[ExecutedTool] = []
        citations: list[Citation] = []
        pending_payload: dict[str, Any] | None = None
        final_text = ""
        model_used = self.router.model_for(tier)

        for _ in range(MAX_TOOL_ITERATIONS):
            if cancel is not None and cancel.is_set():
                return TurnResult(
                    text="", session_id=session.session_id, tools=executed, citations=citations
                )

            system_prompt = build_system_prompt(self.settings, session)

            async def on_text(chunk: str) -> None:
                await emit(JarvisEvent.token(chunk))

            response = await self.router.complete(
                tier=tier,
                system=system_prompt,
                messages=session.history(),
                tools=tool_specs,
                on_text=on_text,
            )
            model_used = response.model or model_used

            session.add_assistant(response.text, response.tool_calls)

            if not response.wants_tools:
                final_text = response.text
                break

            await emit(JarvisEvent.state(State.WORKING))
            results: list[ToolResultBlock] = []
            for call in response.tool_calls:
                block, executed_tool, tool_citations, pending = await self._run_tool_call(
                    session, user_text, call, emit
                )
                results.append(block)
                if executed_tool is not None:
                    executed.append(executed_tool)
                citations.extend(tool_citations)
                if pending is not None:
                    pending_payload = pending
            session.add_tool_results(results)
        else:
            logger.warning("limite d'iterations d'outils atteinte (%d)", MAX_TOOL_ITERATIONS)
            final_text = (
                "Je tourne en rond sur cette demande. Reformule-la ou decoupe-la, "
                "je repars de la."
            )
            session.add_assistant(final_text)

        if not final_text:
            final_text = (
                "Je n'ai pas de reponse fiable a te donner sur ce coup-la."
            )
            session.add_assistant(final_text)

        await emit(JarvisEvent.state(State.SPEAKING))
        if citations:
            await emit(JarvisEvent.citations([c.as_dict() for c in citations]))
        await emit(
            JarvisEvent.message(
                final_text,
                citations=[c.as_dict() for c in citations],
                pending_confirmation=pending_payload,
            )
        )
        return TurnResult(
            text=final_text,
            session_id=session.session_id,
            citations=citations,
            tools=executed,
            pending_confirmation=pending_payload,
            model=model_used,
        )

    # -- execution d'un appel d'outil ---------------------------------------

    async def _run_tool_call(
        self,
        session: SessionMemory,
        user_text: str,
        call: ToolCall,
        emit: EventSink,
    ) -> tuple[ToolResultBlock, ExecutedTool | None, list[Citation], dict[str, Any] | None]:
        """Verifie les permissions puis execute un appel d'outil."""
        started = time.perf_counter()

        if not self.registry.has(call.name):
            message = f"Outil inconnu: {call.name}."
            self._audit(
                session, user_text, call, level=0, decision="deny", status="unknown_tool",
                duration_ms=0, error=message,
            )
            return (
                ToolResultBlock(tool_call_id=call.id, content=message, is_error=True),
                None,
                [],
                None,
            )

        tool = self.registry.get(call.name)
        recipients = self.registry.extract_recipients(call.name, call.arguments)
        verdict: PermissionVerdict = self.policy.evaluate(
            call.name, tool.permission, recipients=recipients
        )

        if verdict.denied:
            message = f"Action refusee ({verdict.reason})."
            await emit(JarvisEvent.tool_end(call.name, ok=False, summary=message))
            self._audit(
                session, user_text, call, level=int(tool.permission), decision="deny",
                status="denied", duration_ms=0, error=verdict.reason,
            )
            return (
                ToolResultBlock(tool_call_id=call.id, content=message, is_error=True),
                ExecutedTool(call.name, False, message, decision="deny"),
                [],
                None,
            )

        if verdict.needs_confirmation:
            action = PendingAction(
                action_id=f"c_{uuid.uuid4().hex[:10]}",
                tool_name=call.name,
                arguments=call.arguments,
                tool_call_id=call.id,
                description=self._describe_action(call),
                permission_level=int(tool.permission),
            )
            session.add_pending(action)
            payload = action.as_dict()
            await emit(
                JarvisEvent.confirmation(payload, question=f"Je fais ca? {action.description}")
            )
            self._audit(
                session, user_text, call, level=int(tool.permission), decision="confirm",
                status="awaiting_confirmation", duration_ms=0,
            )
            message = (
                f"Action '{call.name}' NON executee: elle exige la confirmation de "
                f"l'utilisateur ({verdict.reason}). Demande-lui son accord en une phrase "
                "courte et naturelle, en resumant ce que tu t'appretes a faire. "
                "N'affirme surtout pas que l'action est faite."
            )
            return (
                ToolResultBlock(tool_call_id=call.id, content=message),
                ExecutedTool(call.name, False, "en attente de confirmation", decision="confirm"),
                [],
                payload,
            )

        await emit(JarvisEvent.tool_start(call.name, self._describe_action(call)))
        context = self._build_context(session)
        try:
            result = await self.registry.execute(call.name, call.arguments, context)
        except ToolValidationError as exc:
            duration = int((time.perf_counter() - started) * 1000)
            message = f"Parametres invalides pour {call.name}: {exc.detail or exc}"
            await emit(JarvisEvent.tool_end(call.name, ok=False, summary=message))
            self._audit(
                session, user_text, call, level=int(tool.permission), decision="allow",
                status="invalid_params", duration_ms=duration, error=str(exc.detail or exc),
            )
            return (
                ToolResultBlock(tool_call_id=call.id, content=message, is_error=True),
                ExecutedTool(call.name, False, message),
                [],
                None,
            )
        except (IntegrationNotConfiguredError, IntegrationUnavailableError) as exc:
            duration = int((time.perf_counter() - started) * 1000)
            message = (
                f"{exc.user_message} Dis-le tel quel a l'utilisateur; "
                "ne fabrique aucune donnee de remplacement."
            )
            await emit(JarvisEvent.tool_end(call.name, ok=False, summary=exc.user_message))
            self._audit(
                session, user_text, call, level=int(tool.permission), decision="allow",
                status="integration_unavailable", duration_ms=duration,
                error=str(exc.detail or exc),
            )
            return (
                ToolResultBlock(tool_call_id=call.id, content=message, is_error=True),
                ExecutedTool(call.name, False, exc.user_message),
                [],
                None,
            )
        except Exception as exc:  # noqa: BLE001 - un outil ne doit jamais tuer le tour
            duration = int((time.perf_counter() - started) * 1000)
            logger.exception("echec de l'outil %s", call.name)
            message = (
                f"L'outil {call.name} a echoue. Signale-le a l'utilisateur sans inventer "
                "de resultat."
            )
            await emit(JarvisEvent.tool_end(call.name, ok=False, summary=f"{call.name}: echec"))
            self._audit(
                session, user_text, call, level=int(tool.permission), decision="allow",
                status="error", duration_ms=duration, error=repr(exc),
            )
            return (
                ToolResultBlock(tool_call_id=call.id, content=message, is_error=True),
                ExecutedTool(call.name, False, message),
                [],
                None,
            )

        duration = int((time.perf_counter() - started) * 1000)
        content, signals = self._render_for_model(call.name, result)
        await emit(
            JarvisEvent.tool_end(
                call.name, ok=result.ok, summary=result.summary, data=result.data
            )
        )
        self._audit(
            session, user_text, call, level=int(tool.permission), decision="allow",
            status="ok" if result.ok else "failed", duration_ms=duration,
            result_summary=result.summary, injection_signals=signals,
        )
        return (
            ToolResultBlock(tool_call_id=call.id, content=content, is_error=not result.ok),
            ExecutedTool(call.name, result.ok, result.summary, data=result.data),
            result.citations,
            None,
        )

    # -- confirmations -------------------------------------------------------

    async def _maybe_resolve_confirmation(
        self, session: SessionMemory, user_text: str, emit: EventSink
    ) -> TurnResult | None:
        """Traite un "oui"/"non" repondant a une demande de confirmation."""
        if _NEGATIONS.match(user_text):
            action = session.take_latest_pending()
            session.clear_pending()
            reply = "C'est annule."
            session.add_user_text(user_text)
            session.add_assistant(reply)
            if action is not None:
                self.audit.record(
                    session_id=session.session_id, user_request=user_text,
                    tool=action.tool_name, action="cancelled", parameters=action.arguments,
                    permission_level=action.permission_level, decision="confirm",
                    confirmed=False, status="cancelled", duration_ms=0,
                )
            await emit(JarvisEvent.message(reply))
            return TurnResult(text=reply, session_id=session.session_id)

        if not _AFFIRMATIONS.match(user_text):
            # Ni oui ni non: l'utilisateur change de sujet. On abandonne
            # l'action en attente plutot que de la garder en embuscade.
            session.clear_pending()
            return None

        action = session.take_latest_pending()
        if action is None:
            return None

        session.add_user_text(user_text)
        await emit(JarvisEvent.tool_start(action.tool_name, action.description))
        context = self._build_context(session, confirmed=True)
        started = time.perf_counter()
        try:
            result = await self.registry.execute(
                action.tool_name, action.arguments, context
            )
        except JarvisError as exc:
            duration = int((time.perf_counter() - started) * 1000)
            self.audit.record(
                session_id=session.session_id, user_request=user_text, tool=action.tool_name,
                action="execute_confirmed", parameters=action.arguments,
                permission_level=action.permission_level, decision="confirm", confirmed=True,
                status="failed", duration_ms=duration, error=str(exc.detail or exc),
            )
            await emit(JarvisEvent.tool_end(action.tool_name, ok=False, summary=exc.user_message))
            session.add_assistant(exc.user_message)
            await emit(JarvisEvent.message(exc.user_message))
            return TurnResult(
                text=exc.user_message, session_id=session.session_id, error=str(exc.detail or exc)
            )
        except Exception as exc:  # noqa: BLE001
            duration = int((time.perf_counter() - started) * 1000)
            logger.exception("echec de l'action confirmee %s", action.tool_name)
            self.audit.record(
                session_id=session.session_id, user_request=user_text, tool=action.tool_name,
                action="execute_confirmed", parameters=action.arguments,
                permission_level=action.permission_level, decision="confirm", confirmed=True,
                status="error", duration_ms=duration, error=repr(exc),
            )
            message = "L'action a echoue. Rien n'a ete fait."
            await emit(JarvisEvent.tool_end(action.tool_name, ok=False, summary=message))
            session.add_assistant(message)
            await emit(JarvisEvent.message(message))
            return TurnResult(text=message, session_id=session.session_id, error=repr(exc))

        duration = int((time.perf_counter() - started) * 1000)
        self.audit.record(
            session_id=session.session_id, user_request=user_text, tool=action.tool_name,
            action="execute_confirmed", parameters=action.arguments,
            permission_level=action.permission_level, decision="confirm", confirmed=True,
            status="ok" if result.ok else "failed", duration_ms=duration,
            result_summary=result.summary,
        )
        await emit(
            JarvisEvent.tool_end(
                action.tool_name, ok=result.ok, summary=result.summary, data=result.data
            )
        )
        # On informe le modele du resultat pour qu'il formule la reponse.
        session.add_user_text(
            f"{RUNTIME_PREFIX} L'utilisateur a confirme. "
            f"Resultat de {action.tool_name}: {result.summary}. "
            "Confirme-le en une phrase courte."
        )
        response = await self.router.complete(
            tier=TaskTier.FAST,
            system=build_system_prompt(self.settings, session),
            messages=session.history(),
            tools=None,
        )
        text = response.text or result.summary
        session.add_assistant(text)
        await emit(JarvisEvent.message(text))
        return TurnResult(
            text=text,
            session_id=session.session_id,
            tools=[ExecutedTool(action.tool_name, result.ok, result.summary, decision="confirm")],
            model=response.model,
        )

    async def confirm_action(
        self,
        session: SessionMemory,
        action_id: str,
        *,
        approved: bool,
        sink: EventSink | None = None,
    ) -> TurnResult:
        """Confirmation explicite depuis l'interface (bouton), pas par la voix."""
        emit = sink or noop_sink
        action = session.take_pending(action_id)
        if action is None:
            message = "Cette action n'est plus en attente."
            await emit(JarvisEvent.error(message, code="no_pending_action"))
            return TurnResult(text=message, session_id=session.session_id)
        if not approved:
            self.audit.record(
                session_id=session.session_id, user_request="(refus interface)",
                tool=action.tool_name, action="cancelled", parameters=action.arguments,
                permission_level=action.permission_level, decision="confirm", confirmed=False,
                status="cancelled", duration_ms=0,
            )
            message = "C'est annule."
            session.add_assistant(message)
            await emit(JarvisEvent.message(message))
            return TurnResult(text=message, session_id=session.session_id)
        session.add_pending(action)
        return await self._maybe_resolve_confirmation(session, "oui", emit) or TurnResult(
            text="", session_id=session.session_id
        )

    # -- utilitaires ---------------------------------------------------------

    def _build_context(self, session: SessionMemory, *, confirmed: bool = False) -> ToolContext:
        return ToolContext(
            session_id=session.session_id,
            settings=self.settings,
            session=session,
            memory_store=self.memory_store,
            reminders=self.reminders,
            dry_run=self.settings.dry_run,
            organization=session.organization,
            confirmed=confirmed,
        )

    @staticmethod
    def _render_for_model(tool_name: str, result: ToolResult) -> tuple[str, list[str]]:
        """Prepare le resultat pour le modele, en isolant le contenu externe."""
        if not result.untrusted:
            return result.summary, []
        from jarvis_core.security.sanitize import scan_for_injection

        scan = scan_for_injection(result.summary)
        wrapped = wrap_external_content(
            result.summary,
            source=result.source_label or tool_name,
            kind="email" if "email" in tool_name else "document",
        )
        return wrapped, scan.signals

    @staticmethod
    def _describe_action(call: ToolCall) -> str:
        """Phrase courte decrivant l'action, affichee dans l'interface."""
        args = call.arguments
        if call.name in {"send_email", "draft_email"}:
            to = args.get("to") or []
            targets = ", ".join(to) if isinstance(to, list) else str(to)
            subject = args.get("subject") or "(sans objet)"
            return f"envoyer un courriel a {targets} — {subject}"
        if call.name == "create_calendar_event":
            return f"creer l'evenement « {args.get('title', '')} »"
        if call.name == "cancel_calendar_event":
            return f"annuler l'evenement {args.get('event_id', '')}"
        if call.name == "forget_memory":
            return f"supprimer le souvenir {args.get('memory_id', '')}"
        if call.name == "create_reminder":
            return f"creer un rappel: {args.get('text', '')}"
        return call.name.replace("_", " ")

    @staticmethod
    def _select_tier(user_text: str) -> TaskTier:
        """Routage de modele: on ne sort pas l'artillerie pour dire bonsoir."""
        if len(user_text) <= 60 and _SIMPLE_TURN.match(user_text):
            return TaskTier.FAST
        return TaskTier.BALANCED

    def _audit(
        self,
        session: SessionMemory,
        user_text: str,
        call: ToolCall,
        *,
        level: int,
        decision: str,
        status: str,
        duration_ms: int,
        result_summary: str = "",
        error: str = "",
        injection_signals: list[str] | None = None,
    ) -> None:
        self.audit.record(
            session_id=session.session_id,
            user_request=user_text,
            tool=call.name,
            action="execute",
            parameters=call.arguments,
            permission_level=level,
            decision=decision,
            confirmed=False,
            status=status,
            duration_ms=duration_ms,
            result_summary=result_summary,
            error=error,
            injection_signals=injection_signals,
        )


def build_history_preview(session: SessionMemory, limit: int = 12) -> list[dict[str, str]]:
    """Historique lisible pour l'interface (texte seulement)."""
    preview: list[dict[str, str]] = []
    for message in session.messages[-limit:]:
        text = message.text.strip()
        if not text or text.startswith(RUNTIME_PREFIX):
            continue
        preview.append({"role": message.role, "text": text})
    return preview


__all__ = [
    "ConfigurationError",
    "ExecutedTool",
    "JarvisOrchestrator",
    "LLMMessage",
    "TurnResult",
    "build_history_preview",
]
