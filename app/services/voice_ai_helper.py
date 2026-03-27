# app/services/voice_ai_helper.py
import logging
from typing import Dict, Optional

import httpx

from app.core.config import settings

VOICE_API_BASE = "https://dev.voice.ai/api/v1"

logger = logging.getLogger("voice_ai_helper")


class AgentCache:
    """
    In-memory cache for Voice.AI agent info.

    The asyncio.Lock is created lazily (on first use) instead of at import
    time. Creating it at import time breaks under uvicorn --reload because
    the reloader spawns a new process with a new event loop — the lock then
    belongs to the old (closed) loop and every await on it raises silently,
    producing the blank 'agent_status error:' log line.
    """

    def __init__(self):
        self._cache: Dict[str, Dict] = {}
        self._lock = None   # created lazily on first await

    def _get_lock(self):
        import asyncio
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def get_agent(self, agent_id: str) -> Dict:
        async with self._get_lock():
            if agent_id in self._cache:
                return self._cache[agent_id]

            logger.info(f"Fetching agent info from Voice.AI: {agent_id}")
            headers = {"Authorization": f"Bearer {settings.VOICE_AI_PUBLIC_KEY}"}
            url = f"{VOICE_API_BASE}/connection/agent-status/{agent_id}"

            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, headers=headers)

            if resp.status_code != 200:
                # Include status code so the log line is never blank
                raise Exception(
                    f"Agent status fetch failed — HTTP {resp.status_code}: {resp.text!r}"
                )

            data = resp.json()
            self._cache[agent_id] = {
                "name":         data.get("name"),
                "voice_id":     data.get("voice_id"),
                "status":       data.get("status"),
                "call_allowed": data.get("call_allowed"),
            }
            logger.info(f"Agent cached: {agent_id} — {self._cache[agent_id]}")
            return self._cache[agent_id]

    async def refresh_agent(self, agent_id: str) -> Dict:
        """Force a fresh fetch from Voice.AI, bypassing the cache."""
        async with self._get_lock():
            self._cache.pop(agent_id, None)
        return await self.get_agent(agent_id)

    def invalidate(self, agent_id: Optional[str] = None):
        """Synchronously clear one entry or the whole cache."""
        if agent_id:
            self._cache.pop(agent_id, None)
        else:
            self._cache.clear()


# Singleton — import this everywhere
agent_cache = AgentCache()