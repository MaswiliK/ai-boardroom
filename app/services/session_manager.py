# app/services/session_manager.py
import logging
from datetime import datetime
from typing import Dict, Optional
from uuid import uuid4

logger = logging.getLogger("session_manager")


class SessionManager:
    """In-memory session store for tracking active Voice.AI calls."""

    def __init__(self):
        self._sessions: Dict[str, Dict] = {}

    # ── Create ────────────────────────────────────────────────────────────────
    def create_session(self, agent_name: str, agent_id: str) -> Dict:
        """
        Create a session placeholder before the Voice.AI call_id is known.
        call_id is populated later via attach_call_id().
        """
        session_id = str(uuid4())
        self._sessions[session_id] = {
            "session_id": session_id,
            "agent_name": agent_name,
            "agent_id":   agent_id,
            "call_id":    None,                      # filled in after API response
            "started_at": datetime.utcnow().isoformat(),
            "status":     "pending",
        }
        logger.info(f"Session created: {session_id}")
        return self._sessions[session_id]

    # ── Attach call_id once Voice.AI responds ─────────────────────────────────
    def attach_call_id(self, session_id: str, call_id: str) -> Optional[Dict]:
        """Link a Voice.AI call_id to an existing session and mark it active."""
        session = self._sessions.get(session_id)
        if not session:
            logger.warning(f"attach_call_id: session not found ({session_id})")
            return None
        session["call_id"] = call_id
        session["status"]  = "active"
        logger.info(f"call_id attached: {call_id} → session {session_id}")
        return session

    # ── Read ──────────────────────────────────────────────────────────────────
    def get_session(self, session_id: str) -> Optional[Dict]:
        return self._sessions.get(session_id)

    # Alias kept for callers that use the longer name
    def get_session_by_id(self, session_id: str) -> Optional[Dict]:
        return self.get_session(session_id)

    def get_session_by_call_id(self, call_id: str) -> Optional[Dict]:
        for session in self._sessions.values():
            if session.get("call_id") == call_id:
                return session
        return None

    # ── End ───────────────────────────────────────────────────────────────────
    def end_session(self, session_id: str) -> Optional[Dict]:
        session = self._sessions.get(session_id)
        if session:
            session["status"]   = "ended"
            session["ended_at"] = datetime.utcnow().isoformat()
            logger.info(f"Session ended: {session_id}")
        return session

    # ── List ──────────────────────────────────────────────────────────────────
    def list_active_sessions(self) -> Dict[str, Dict]:
        return {
            sid: s for sid, s in self._sessions.items()
            if s["status"] == "active"
        }


# Singleton — import this everywhere
session_manager = SessionManager()