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
from .gazelle import GazelleModel
from .profiles import ProfileStore
from .recognizer import Recognizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("gaze")


@asynccontextmanager
async def lifespan(app: FastAPI):
    disable_describe = os.environ.get("GAZE_DISABLE_DESCRIBE", "0") == "1"
    disable_gazelle = os.environ.get("GAZE_DISABLE_GAZELLE", "0") == "1"
    log.info(
        "starting gaze-server (recognizer=%s gazelle=%s moondream=%s db=%s)",
        settings.recognizer,
        "off" if disable_gazelle else settings.gazelle_variant,
        "off" if disable_describe else f"{settings.moondream_repo}@{settings.moondream_revision}",
        settings.db_path,
    )

    store = ProfileStore(settings.db_path)
    recognizer = Recognizer(
        model_name=settings.recognizer,
        det_size=settings.det_size,
        root=str(settings.models_dir),
    )

    gazelle_model: GazelleModel | None = None
    if not disable_gazelle:
        try:
            gazelle_model = GazelleModel(
                variant=settings.gazelle_variant,
                device=settings.gazelle_device,
            )
        except Exception as e:
            log.exception("failed to load gazelle (%s) — gaze direction disabled", e)

    moondream_model: GazeModel | None = None
    if not disable_describe:
        try:
            moondream_model = GazeModel(
                repo=settings.moondream_repo,
                revision=settings.moondream_revision,
                cache_dir=settings.models_dir,
                device=settings.moondream_device,
            )
        except Exception as e:
            log.exception("failed to load moondream (%s) — describe disabled", e)

    engine = GazeEngine(store, recognizer, gazelle_model, moondream_model)

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
