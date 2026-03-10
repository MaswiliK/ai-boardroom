# app/main.py
import logging
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError

from app.core.config import settings
from app.api.routes import health, voice_ai, voice_stream
from app.api.routes.voice_ai import validation_error_handler

logger = logging.getLogger("main")

app = FastAPI(title=settings.PROJECT_NAME)

# Log every 422 with the full validation detail so future errors are diagnosable
app.add_exception_handler(RequestValidationError, validation_error_handler)

# ── API routes ────────────────────────────────────────────────────────────────
app.include_router(health.router,       prefix="/api/health", tags=["Health"])
app.include_router(voice_ai.router,     tags=["VoiceAI"])
# FIX 2: voice_stream.router already carries prefix="/api/voice" internally,
#         so we must NOT add it again here — doing so doubled the path to
#         /api/voice/api/voice/stream, causing every WebSocket to 404.
app.include_router(voice_stream.router, tags=["VoiceStream"])


@app.get("/api/config")
def get_config():
    """Frontend fetches this to initialise the Voice.AI SDK."""
    return {
        "voiceAiPublicKey": settings.VOICE_AI_PUBLIC_KEY,
        "environment":      settings.ENVIRONMENT,
    }


# ── Static frontend ────────────────────────────────────────────────────────────
# FIX 3: mount AFTER all API routes so /api/* is never shadowed.
#         StaticFiles with html=True already serves index.html for "/",
#         so the explicit HTMLResponse route is redundant and was unreachable.
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")