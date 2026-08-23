"""Canal temps reel.

Protocole (JSON dans les deux sens).

Client -> serveur:
    {"type": "text",    "text": "..."}                      demande textuelle
    {"type": "audio",   "audio_base64": "...", "mime": "..."} extrait vocal complet
    {"type": "confirm", "action_id": "...", "approved": true}
    {"type": "cancel"}                                       interruption (barge-in)
    {"type": "org",     "organization": "PORTAIL"}
    {"type": "reset"}

Serveur -> client: voir `jarvis_core.orchestrator.events.EventType`.

L'interruption est immediate cote client (il coupe l'audio) et cooperative
cote serveur (le tour en cours s'arrete a la prochaine etape verifiable).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from jarvis_core.errors import JarvisError
from jarvis_core.orchestrator.events import JarvisEvent, State
from jarvis_core.runtime import JarvisRuntime
from jarvis_core.voice.tts.base import split_sentences

logger = logging.getLogger(__name__)

#: Taille maximale d'un extrait audio accepte (10 Mo ~ plusieurs minutes d'opus).
MAX_AUDIO_BYTES = 10 * 1024 * 1024


async def websocket_endpoint(websocket: WebSocket, runtime: JarvisRuntime) -> None:
    """Boucle de traitement d'une connexion temps reel."""
    await websocket.accept()
    session = runtime.sessions.get_or_create(websocket.query_params.get("session_id"))
    cancel = asyncio.Event()

    async def emit(event: JarvisEvent) -> None:
        try:
            await websocket.send_json(event.as_dict())
        except (WebSocketDisconnect, RuntimeError):
            cancel.set()

    await emit(
        JarvisEvent(
            type=JarvisEvent.state(State.IDLE).type,
            payload={
                "state": State.IDLE.value,
                "detail": "connecte",
                "session_id": session.session_id,
                "system": runtime.system_info(),
            },
        )
    )

    try:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type")

            if kind == "cancel":
                cancel.set()
                await emit(JarvisEvent.state(State.IDLE, "interrompu"))
                continue

            if kind == "reset":
                session.reset()
                await emit(JarvisEvent.state(State.IDLE, "session reinitialisee"))
                continue

            if kind == "org":
                session.organization = str(message.get("organization") or "PERSONAL")
                await emit(JarvisEvent.state(State.IDLE, f"organisation: {session.organization}"))
                continue

            if kind == "confirm":
                result = await runtime.orchestrator.confirm_action(
                    session,
                    str(message.get("action_id", "")),
                    approved=bool(message.get("approved")),
                    sink=emit,
                )
                await _speak(runtime, result.text, emit)
                continue

            cancel = asyncio.Event()

            if kind == "audio":
                text = await _transcribe(runtime, message, emit)
                if text is None:
                    continue
            elif kind == "text":
                text = str(message.get("text", "")).strip()
                if not text:
                    continue
                await emit(JarvisEvent.transcript(text, final=True))
            else:
                await emit(
                    JarvisEvent.error(f"type de message inconnu: {kind}", code="bad_message")
                )
                continue

            try:
                result = await runtime.orchestrator.handle_text(
                    session, text, sink=emit, cancel=cancel
                )
            except JarvisError as exc:
                runtime.metrics.record_error()
                await emit(JarvisEvent.error(exc.user_message, code="jarvis_error"))
                continue

            runtime.metrics.record_turn(result.latency_ms)
            for tool in result.tools:
                runtime.metrics.record_tool(tool.name, ok=tool.ok)
            if result.error:
                runtime.metrics.record_error()

            if not cancel.is_set():
                await _speak(runtime, result.text, emit)
            await emit(JarvisEvent.state(State.IDLE))

    except WebSocketDisconnect:
        logger.debug("client deconnecte (session %s)", session.session_id)
    except Exception:  # noqa: BLE001 - on ne laisse jamais tomber la socket en silence
        logger.exception("erreur websocket")
        with contextlib.suppress(Exception):  # pragma: no cover
            await emit(JarvisEvent.error("Erreur interne du canal temps reel.", code="ws_error"))


async def _transcribe(
    runtime: JarvisRuntime, message: dict[str, Any], emit: Any
) -> str | None:
    """Decode et transcrit un extrait audio recu du client."""
    raw = message.get("audio_base64") or ""
    try:
        audio = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        await emit(JarvisEvent.error("Extrait audio illisible.", code="bad_audio"))
        return None
    if not audio:
        await emit(JarvisEvent.error("Extrait audio vide.", code="bad_audio"))
        return None
    if len(audio) > MAX_AUDIO_BYTES:
        await emit(JarvisEvent.error("Extrait audio trop long.", code="audio_too_large"))
        return None

    await emit(JarvisEvent.state(State.TRANSCRIBING))
    try:
        transcript = await runtime.stt.transcribe(
            audio,
            mime=str(message.get("mime") or "audio/webm"),
            language=runtime.settings.default_language,
        )
    except JarvisError as exc:
        await emit(JarvisEvent.error(exc.user_message, code="stt_error"))
        return None

    runtime.metrics.stt_latency.add(transcript.duration_ms)
    if not transcript.text:
        await emit(JarvisEvent.error("Je n'ai rien compris.", code="empty_transcript"))
        return None
    await emit(JarvisEvent.transcript(transcript.text, final=True))
    return transcript.text


async def _speak(runtime: JarvisRuntime, text: str, emit: Any) -> None:
    """Synthetise la reponse phrase par phrase et l'envoie au client.

    Si aucun moteur serveur n'est configure, on n'envoie rien: le client lit le
    texte avec la voix du systeme.
    """
    if not text or not runtime.tts.available:
        return
    await emit(JarvisEvent.state(State.SPEAKING))
    for sentence in split_sentences(text):
        try:
            audio = await runtime.tts.synthesize(sentence)
        except JarvisError as exc:
            await emit(JarvisEvent.error(exc.user_message, code="tts_error"))
            return
        if audio is None:
            return
        runtime.metrics.tts_latency.add(audio.duration_ms)
        await emit(
            JarvisEvent.audio(base64.b64encode(audio.data).decode("ascii"), audio.mime)
        )
