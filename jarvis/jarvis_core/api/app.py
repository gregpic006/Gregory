"""Application FastAPI.

Deux surfaces:

* REST, pour les operations ponctuelles (chat texte, transcription, synthese,
  etat systeme, audit);
* WebSocket `/ws`, pour la conversation temps reel: transcription, streaming de
  la reponse, statut des outils, audio, interruption.

L'API est concue pour servir plusieurs clients (desktop, web, mobile) sans
changement: elle ne suppose rien de l'interface.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from jarvis_core.api.schemas import ChatRequest, ConfirmRequest, SpeakRequest, TurnResponse
from jarvis_core.api.ws import websocket_endpoint
from jarvis_core.config import Settings, get_settings
from jarvis_core.errors import JarvisError, SpeechError
from jarvis_core.logging_setup import setup_logging
from jarvis_core.orchestrator.orchestrator import build_history_preview
from jarvis_core.runtime import JarvisRuntime, build_runtime

logger = logging.getLogger(__name__)

UI_DIST = Path(__file__).resolve().parents[2] / "ui" / "dist"


def get_runtime(request: Request) -> JarvisRuntime:
    """Dependance FastAPI: recupere le runtime attache a l'application."""
    runtime: JarvisRuntime = request.app.state.runtime
    return runtime


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construit l'application ASGI."""
    settings = settings or get_settings()
    setup_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runtime = build_runtime(settings)
        app.state.runtime = runtime
        logger.info(
            "%s pret — LLM=%s STT=%s TTS=%s env=%s",
            runtime.settings.jarvis_name,
            runtime.router.provider.name,
            runtime.stt.name,
            runtime.tts.name,
            runtime.settings.env,
        )
        try:
            yield
        finally:
            await runtime.aclose()

    app = FastAPI(
        title=f"{settings.jarvis_name} API",
        version="0.1.0",
        description="API interne de l'assistant personnel JARVIS.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(JarvisError)
    async def jarvis_error_handler(request: Request, exc: JarvisError) -> JSONResponse:
        logger.warning("erreur applicative: %s", exc.detail or exc)
        return JSONResponse(
            status_code=400, content={"error": exc.user_message, "detail": exc.detail}
        )

    # -- etat systeme --------------------------------------------------------

    @app.get("/api/health")
    async def health(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
        return {"status": "ok", "name": runtime.settings.jarvis_name}

    @app.get("/api/system")
    async def system(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
        return runtime.system_info()

    @app.get("/api/metrics")
    async def metrics(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
        return runtime.metrics.snapshot(runtime.router.spend.snapshot())

    @app.get("/api/audit")
    async def audit(
        limit: int = 50, runtime: JarvisRuntime = Depends(get_runtime)
    ) -> dict[str, Any]:
        return {"entries": runtime.audit_sink.recent(min(limit, 200))}

    # -- conversation --------------------------------------------------------

    @app.post("/api/chat", response_model=TurnResponse)
    async def chat(
        payload: ChatRequest, runtime: JarvisRuntime = Depends(get_runtime)
    ) -> dict[str, Any]:
        session = runtime.sessions.get_or_create(payload.session_id)
        if payload.organization:
            session.organization = payload.organization
        result = await runtime.orchestrator.handle_text(session, payload.text)
        runtime.metrics.record_turn(result.latency_ms)
        for tool in result.tools:
            runtime.metrics.record_tool(tool.name, ok=tool.ok)
        if result.error:
            runtime.metrics.record_error()
        return result.as_dict()

    @app.post("/api/confirm", response_model=TurnResponse)
    async def confirm(
        payload: ConfirmRequest, runtime: JarvisRuntime = Depends(get_runtime)
    ) -> dict[str, Any]:
        session = runtime.sessions.get(payload.session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session inconnue.")
        result = await runtime.orchestrator.confirm_action(
            session, payload.action_id, approved=payload.approved
        )
        return result.as_dict()

    @app.get("/api/session/{session_id}")
    async def session_state(
        session_id: str, runtime: JarvisRuntime = Depends(get_runtime)
    ) -> dict[str, Any]:
        session = runtime.sessions.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Session inconnue.")
        return {**session.snapshot(), "history": build_history_preview(session)}

    @app.delete("/api/session/{session_id}")
    async def reset_session(
        session_id: str, runtime: JarvisRuntime = Depends(get_runtime)
    ) -> dict[str, str]:
        runtime.sessions.drop(session_id)
        return {"status": "reset"}

    # -- voix ----------------------------------------------------------------

    @app.post("/api/voice/transcribe")
    async def transcribe(
        audio: UploadFile = File(...),
        language: str = Form(default=""),
        runtime: JarvisRuntime = Depends(get_runtime),
    ) -> dict[str, Any]:
        content = await audio.read()
        transcript = await runtime.stt.transcribe(
            content,
            mime=audio.content_type or "audio/webm",
            language=language or runtime.settings.default_language,
        )
        runtime.metrics.stt_latency.add(transcript.duration_ms)
        return transcript.as_dict()

    @app.post("/api/voice/speak")
    async def speak(
        payload: SpeakRequest, runtime: JarvisRuntime = Depends(get_runtime)
    ) -> Response:
        audio = await runtime.tts.synthesize(payload.text, voice=payload.voice)
        if audio is None:
            # Aucun moteur serveur: le client utilise la voix du systeme.
            return JSONResponse(status_code=204, content=None)
        runtime.metrics.tts_latency.add(audio.duration_ms)
        return Response(content=audio.data, media_type=audio.mime)

    # -- temps reel ----------------------------------------------------------

    @app.websocket("/ws")
    async def ws(websocket: WebSocket) -> None:
        await websocket_endpoint(websocket, websocket.app.state.runtime)

    # -- interface ------------------------------------------------------------

    if UI_DIST.is_dir():
        app.mount("/assets", StaticFiles(directory=UI_DIST / "assets"), name="assets")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(UI_DIST / "index.html")
    else:

        @app.get("/")
        async def index_placeholder() -> dict[str, str]:
            return {
                "status": "ok",
                "message": (
                    "L'interface n'est pas compilee. Lance 'npm run dev' dans ui/ "
                    "pour le mode developpement, ou 'npm run build' pour la servir ici."
                ),
            }

    return app


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


__all__ = ["create_app", "SpeechError", "_b64"]
