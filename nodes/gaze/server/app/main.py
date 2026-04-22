"""FastAPI entrypoint for the gaze server."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import build_router
from .config import settings
from .engine import GazeEngine
from .gaze import GazeModel
from .profiles import ProfileStore
from .recognizer import Recognizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("gaze")


@asynccontextmanager
async def lifespan(app: FastAPI):
    disable_gaze = os.environ.get("GAZE_DISABLE_GAZE_MODEL", "0") == "1"
    log.info(
        "starting gaze-server (recognizer=%s moondream=%s db=%s)",
        settings.recognizer,
        "off" if disable_gaze else f"{settings.moondream_repo}@{settings.moondream_revision}",
        settings.db_path,
    )

    store = ProfileStore(settings.db_path)
    recognizer = Recognizer(
        model_name=settings.recognizer,
        det_size=settings.det_size,
        root=str(settings.models_dir),
    )

    gaze_model: GazeModel | None = None
    if not disable_gaze:
        try:
            gaze_model = GazeModel(
                repo=settings.moondream_repo,
                revision=settings.moondream_revision,
                cache_dir=settings.models_dir,
                device=settings.moondream_device,
            )
        except Exception as e:
            log.exception("failed to load moondream (%s) — gaze detection disabled", e)

    engine = GazeEngine(store, recognizer, gaze_model)

    app.state.store = store
    app.state.engine = engine
    app.include_router(build_router(store, engine))

    try:
        yield
    finally:
        store.close()
        log.info("gaze-server stopped")


app = FastAPI(title="gaze-server", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
