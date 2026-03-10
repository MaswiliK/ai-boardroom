# app/services/voice_ai_helper.py
import asyncio
import httpx
from app.core.config import settings

VOICE_API_BASE = "https://dev.voice.ai/api/v1"
agent_id = "25377ee6-17a7-4f62-9953-7b583a8b2760"

class AgentCache:
    """
    Simple in-memory cache for personal Voice.AI agent info.
    Fetches once at startup and refreshes on demand.
    """
    def __init__(self):
        self._data = {}
        self._lock = asyncio.Lock()

    async def get_agent(self, agent_id: str):
        # Return cached if exists
        async with self._lock:
            if agent_id in self._data:
                return self._data[agent_id]

            # Fetch from Voice.AI API
            headers = {"Authorization": f"Bearer {settings.VOICE_AI_PUBLIC_KEY}"}
            url = f"{VOICE_API_BASE}/connection/agent-status/{agent_id}"
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, headers=headers)

            if resp.status_code != 200:
                raise Exception(f"Failed to fetch agent status: {resp.text}")

            agent_info = resp.json()
            # Cache it
            self._data[agent_id] = {
                "name": agent_info.get("name"),
                "voice_id": agent_info.get("voice_id"),
                "status": agent_info.get("status"),
                "call_allowed": agent_info.get("call_allowed")
            }
            return self._data[agent_id]

    async def refresh_agent(self, agent_id: str):
        """Force refresh from Voice.AI"""
        async with self._lock:
            if agent_id in self._data:
                del self._data[agent_id]
        return await self.get_agent(agent_id)

# singleton cache instance
agent_cache = AgentCache()