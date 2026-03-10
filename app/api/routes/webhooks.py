# app/api/routes/webhooks.py
# NOT wired up yet — add to main.py when Voice.AI webhook delivery is configured:
#   from app.api.routes import webhooks
#   app.include_router(webhooks.router, prefix="/api", tags=["Webhooks"])
#
# In Voice.AI dashboard, set webhook URL to: https://your-domain/api/webhooks/voice

import logging
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

from app.services.session_manager import session_manager

router = APIRouter()
logger = logging.getLogger("webhooks")

# Set this in .env as VOICE_AI_WEBHOOK_SECRET and verify on every inbound call
# WEBHOOK_SECRET = settings.VOICE_AI_WEBHOOK_SECRET


class TranscriptPayload(BaseModel):
    call_id:    str
    transcript: str
    speaker:    Optional[str] = None
    timestamp:  Optional[str] = None


class CallEndedPayload(BaseModel):
    call_id:  str
    duration: Optional[int] = None   # seconds
    reason:   Optional[str] = None


@router.post("/webhooks/voice/transcript", status_code=status.HTTP_200_OK)
async def transcript_webhook(
    payload: TranscriptPayload,
    # x_webhook_signature: Optional[str] = Header(None),  # uncomment + verify
):
    """Receive real-time transcript segments from Voice.AI."""
    logger.info(f"Transcript [{payload.speaker}] call={payload.call_id}: {payload.transcript[:80]}")

    session = session_manager.get_session_by_call_id(payload.call_id)
    if not session:
        # Voice.AI may fire webhooks after the session ends — not an error
        logger.debug(f"No active session for call_id={payload.call_id}")
        return {"ok": True}

    # TODO: persist to DB
    # db.save_transcript(call_id=payload.call_id, speaker=payload.speaker,
    #                    text=payload.transcript, timestamp=payload.timestamp)

    return {"ok": True}


@router.post("/webhooks/voice/call-ended", status_code=status.HTTP_200_OK)
async def call_ended_webhook(payload: CallEndedPayload):
    """Receive call-ended notification from Voice.AI."""
    logger.info(f"Call ended: call_id={payload.call_id} duration={payload.duration}s")

    session = session_manager.get_session_by_call_id(payload.call_id)
    if session:
        session_manager.end_session(session["session_id"])

    return {"ok": True}