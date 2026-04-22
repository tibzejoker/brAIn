"""FastAPI entrypoint."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .api import build_router
from .config import settings
from .engine import build_engine
from .identity import IdentityResolver
from .profiles import ProfileStore
from .ws import SessionHub, audio_endpoint, events_endpoint

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("voice")


def _ensure_models() -> None:
    """Download ONNX models on first boot (idempotent)."""
    vad = settings.models_dir / "silero_vad.onnx"
    emb = settings.models_dir / settings.embedding_model_file
    if vad.is_file() and emb.is_file():
        return
    log.info("one or more models missing, downloading into %s", settings.models_dir)
    from .setup_models import main as setup_main
    setup_main()


@asynccontextmanager
async def lifespan(app: FastAPI):
    import os

    engine_choice = os.environ.get("VOICE_ENGINE", "stub").lower()
    log.info("starting voice-server (engine=%s stt=%s lang=%s)",
             engine_choice, settings.stt_model, settings.language)
    if engine_choice == "real":
        _ensure_models()
    store = ProfileStore(settings.db_path)
    identity = IdentityResolver(store)
    engine = build_engine(identity)
    hub = SessionHub(engine, identity)

    app.state.store = store
    app.state.hub = hub
    app.include_router(build_router(store, hub))

    try:
        yield
    finally:
        await hub.stop_session()
        store.close()
        log.info("voice-server stopped")


app = FastAPI(title="voice-server", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws/audio")
async def ws_audio(ws: WebSocket, session_id: str = "default") -> None:
    hub: SessionHub = ws.app.state.hub
    await audio_endpoint(ws, hub, session_id)


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket, session_id: str = "default") -> None:
    hub: SessionHub = ws.app.state.hub
    await events_endpoint(ws, hub, session_id)
