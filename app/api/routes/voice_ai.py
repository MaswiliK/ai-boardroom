# app/api/routes/voice_ai.py
import logging
from typing import Any, Dict, Optional

import json

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.config import settings
from app.services.session_manager import session_manager
from app.services.voice_ai_helper import agent_cache

router = APIRouter(prefix="/api/voice", tags=["VoiceAI"])

VOICE_API_BASE = "https://dev.voice.ai/api/v1"

logger = logging.getLogger("voice_ai")


# ── Request models ────────────────────────────────────────────────────────────

class ConnectionRequest(BaseModel):
    agent_id:    str
    # FIX: Optional[Dict] = {} is a mutable default that Pydantic v2 rejects.
    #      Use Field(default_factory=dict) and fully parameterise the type.
    metadata:    Optional[Dict[str, Any]] = Field(default_factory=dict)
    environment: Optional[str]            = "development"


# ── Validation error logger (attach to app in main.py if needed) ─────────────
# Import and use:  app.add_exception_handler(RequestValidationError, validation_error_handler)
async def validation_error_handler(request: Request, exc: Exception):
    logger.error(f"422 Validation error on {request.url}: {exc}")
    return JSONResponse(status_code=422, content={"detail": str(exc)})


# ── Agent status ──────────────────────────────────────────────────────────────

@router.get("/agent-status/{agent_id}")
async def agent_status(agent_id: str):
    """Fetch live agent status from Voice.AI (cached)."""
    try:
        return await agent_cache.get_agent(agent_id)
    except Exception as exc:
        logger.error(f"agent_status error: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Create connection ─────────────────────────────────────────────────────────

@router.post("/connection")
async def get_connection(payload: ConnectionRequest):
    """
    Request Voice.AI connection details, create a local session, and return
    everything the frontend needs to open the WebSocket stream.

    Order of operations matters:
        1. Create session placeholder (no call_id yet)
        2. Call Voice.AI API → receive call_id
        3. Attach call_id to session
    """
    # 1. Resolve agent name for the session label
    try:
        agent_info = await agent_cache.get_agent(payload.agent_id)
        agent_name = agent_info.get("name", payload.agent_id)
    except Exception:
        agent_name = payload.agent_id

    # 2. Create placeholder session (call_id is None until Voice.AI responds)
    session = session_manager.create_session(
        agent_name=agent_name,
        agent_id=payload.agent_id,
    )

    # 3. Request connection details from Voice.AI
    url = f"{VOICE_API_BASE}/connection/connection-details"
    headers = {
        "Authorization": f"Bearer {settings.VOICE_AI_PUBLIC_KEY}",
        "Content-Type":  "application/json",
    }
    body = {
        "agent_id": payload.agent_id,
        # Voice.AI expects metadata as a JSON-encoded STRING, not a dict object
        "metadata": json.dumps({
            "session_id": session["session_id"],
            "agent_name": agent_name,
            **(payload.metadata or {}),
        }),
        "environment": payload.environment,
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=body, headers=headers)

    if resp.status_code == 402:
        session_manager.end_session(session["session_id"])  # clean up orphan
        raise HTTPException(status_code=402, detail="Insufficient Voice.AI credits")

    if resp.status_code != 200:
        session_manager.end_session(session["session_id"])
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    data             = resp.json()
    server_url       = data.get("server_url")
    participant_token = data.get("participant_token")
    call_id          = data.get("call_id")

    if not all([server_url, participant_token, call_id]):
        session_manager.end_session(session["session_id"])
        raise HTTPException(status_code=500, detail="Incomplete response from Voice.AI API")

    # 4. Attach call_id now that we have it
    session_manager.attach_call_id(session["session_id"], call_id)

    logger.info(f"Connection ready — call_id={call_id}  session={session['session_id']}")

    return {
        "server_url":        server_url,
        "participant_token": participant_token,
        "call_id":           call_id,
        "session_id":        session["session_id"],
    }


# ── End call ──────────────────────────────────────────────────────────────────

@router.post("/calls/{call_id}/end")
async def end_call(call_id: str):
    """End the call in Voice.AI and mark the local session as ended."""
    url     = f"{VOICE_API_BASE}/calls/{call_id}/end"
    headers = {"Authorization": f"Bearer {settings.VOICE_AI_PUBLIC_KEY}"}

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, headers=headers)

    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)

    session = session_manager.get_session_by_call_id(call_id)
    if session:
        session_manager.end_session(session["session_id"])

    return resp.json()


# ── Debug / analytics ─────────────────────────────────────────────────────────

@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Retrieve session details for debugging or analytics."""
    session = session_manager.get_session(session_id)   # FIX: was get_session() which didn't exist
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session