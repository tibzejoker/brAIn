"""FastAPI entrypoint for the intent server."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import IntentBroadcaster, build_router
from .clients import GazeEventPoller, VoiceClient
from .config import settings
from .engine import CorrelatorConfig, IntentCorrelator
from .persons import PersonStore
from .proxy import build_proxy
from .timeline import Timeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("intent")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info(
        "starting intent-server on :%d (voice=%s gaze=%s db=%s)",
        settings.port, settings.voice_url, settings.gaze_url, settings.db_path,
    )

    store = PersonStore(settings.db_path)
    timeline = Timeline(retention_s=settings.timeline_retention_s)
    broadcaster = IntentBroadcaster()

    correlator = IntentCorrelator(
        store=store,
        timeline=timeline,
        cfg=CorrelatorConfig(pre_s=settings.corr_pre_s, post_s=settings.corr_post_s),
        broadcast_cb=broadcaster.push,
    )

    voice_client = VoiceClient(
        voice_url=settings.voice_url,
        session_id=settings.voice_session,
        store=store,
        timeline=timeline,
        intent_cb=correlator.on_segment,
    )
    gaze_poller = GazeEventPoller(
        gaze_url=settings.gaze_url,
        interval_s=settings.gaze_poll_interval_s,
        store=store,
        timeline=timeline,
    )

    # Shared HTTP client for proxies.
    http_client = httpx.AsyncClient()
    app.include_router(build_proxy("voice", settings.voice_url, http_client))
    app.include_router(build_proxy("gaze", settings.gaze_url, http_client))
    app.include_router(build_router(store, timeline, broadcaster))

    @app.get("/api/health")
    async def health() -> dict:
        async def ping(url: str) -> bool:
            try:
                r = await http_client.get(f"{url.rstrip('/')}/api/health", timeout=2.0)
                return r.status_code == 200
            except Exception:  # noqa: BLE001
                return False
        return {
            "status": "ok",
            "voice_up": await ping(settings.voice_url),
            "gaze_up": await ping(settings.gaze_url),
            "persons": len(store.list()),
        }

    await voice_client.start()
    await gaze_poller.start()

    try:
        yield
    finally:
        await voice_client.stop()
        await gaze_poller.stop()
        await http_client.aclose()
        store.close()
        log.info("intent-server stopped")


app = FastAPI(title="intent-server", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
