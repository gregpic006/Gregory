"""Routes de connexion des integrations.

Le flux Google, vu de l'interface:

    POST /api/integrations/google/connect   -> renvoie l'URL de consentement
    (le navigateur va chez Google, l'utilisateur accepte)
    GET  /api/integrations/google/callback  -> Google renvoie ici avec un code
    POST /api/integrations/google/disconnect

Le code d'autorisation ne transite que par la boucle locale. Le mot de passe
Google n'est jamais vu par JARVIS.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse

from jarvis_core.errors import JarvisError
from jarvis_core.runtime import JarvisRuntime

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


def get_runtime(request: Request) -> JarvisRuntime:
    runtime: JarvisRuntime = request.app.state.runtime
    return runtime


@router.get("/google/status")
async def google_status(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Etat de la connexion Google. Ne contient aucun secret."""
    return runtime.google.status()


@router.post("/google/connect")
async def google_connect(runtime: JarvisRuntime = Depends(get_runtime)) -> dict[str, Any]:
    """Demarre le flux OAuth et retourne l'URL de consentement."""
    google = runtime.google
    if not google.configured:
        raise HTTPException(
            status_code=400,
            detail=(
                "GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET ne sont pas renseignes. "
                "Voir docs/google-setup.md."
            ),
        )
    if not (runtime.settings.feature_gmail or runtime.settings.feature_calendar):
        raise HTTPException(
            status_code=400,
            detail=(
                "Active JARVIS_FEATURE_GMAIL et/ou JARVIS_FEATURE_CALENDAR dans .env "
                "avant de connecter le compte: sans cela, aucune permission utile "
                "ne serait demandee."
            ),
        )
    url, state = google.start_connection()
    return {"authorization_url": url, "state": state, "scopes": google.requested_scopes()}


@router.get("/google/callback", response_class=HTMLResponse)
async def google_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    runtime: JarvisRuntime = Depends(get_runtime),
) -> HTMLResponse:
    """Point de retour de Google. C'est le navigateur qui atterrit ici."""
    if error:
        return _page("Connexion refusee", f"Google a repondu: {error}", ok=False)
    if not code or not state:
        return _page("Requete incomplete", "Code ou state manquant.", ok=False)

    try:
        info = await runtime.google.complete_connection(code=code, state=state)
    except JarvisError as exc:
        logger.warning("echec de la connexion Google: %s", exc.detail or exc)
        return _page("Connexion echouee", exc.user_message, ok=False)

    account = info.get("account") or "ton compte Google"
    granted = ", ".join(info.get("scopes", [])) or "aucune"
    return _page(
        "Compte connecte",
        f"{account} est maintenant relie a JARVIS.<br><br>"
        f"<span class='scopes'>Permissions accordees : {granted}</span><br><br>"
        "Tu peux fermer cet onglet et revenir a JARVIS.",
        ok=True,
    )


@router.post("/google/disconnect")
async def google_disconnect(
    account: str = "", runtime: JarvisRuntime = Depends(get_runtime)
) -> dict[str, Any]:
    """Revoque l'acces cote Google et supprime les jetons locaux."""
    removed = await runtime.google.disconnect(account or None)
    return {"disconnected": removed, "status": runtime.google.status()}


def _page(title: str, message: str, *, ok: bool) -> HTMLResponse:
    """Page de retour minimale, dans l'esprit de l'interface."""
    accent = "#4cc9f0" if ok else "#f87171"
    html = f"""<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>JARVIS — {title}</title>
<style>
  body {{ margin:0; height:100vh; display:grid; place-items:center;
         background:#05070c; color:#dbe4f2;
         font-family:"Segoe UI",system-ui,sans-serif; }}
  .card {{ max-width:520px; padding:34px 38px; border:1px solid #1b2537;
           border-radius:12px; background:#0a0e17; text-align:center; }}
  h1 {{ margin:0 0 14px; font-size:19px; font-weight:500; color:{accent}; }}
  p {{ margin:0; line-height:1.65; color:#9fb0c8; font-size:14px; }}
  .brand {{ letter-spacing:.42em; font-size:12px; color:{accent};
            margin-bottom:22px; text-transform:uppercase; }}
  .scopes {{ font-size:12px; color:#5f6f88; word-break:break-all; }}
</style></head>
<body><div class="card">
  <div class="brand">Jarvis</div><h1>{title}</h1><p>{message}</p>
</div></body></html>"""
    return HTMLResponse(content=html, status_code=200 if ok else 400)
