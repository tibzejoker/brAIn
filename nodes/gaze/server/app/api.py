"""REST endpoints: profile CRUD + detection."""
from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile

from .engine import GazeEngine
from .models import DetectBase64In, DetectResponse, MergeIn, ProfileIn, ProfilePatch
from .profiles import ProfileStore

log = logging.getLogger(__name__)


def build_router(store: ProfileStore, engine: GazeEngine) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["gaze"])

    @router.get("/health")
    def health() -> dict[str, object]:
        return {
            "status": "ok",
            "gaze_model": engine._gaze is not None,  # noqa: SLF001
            "profiles": len(store.list()),
        }

    @router.get("/profiles")
    def list_profiles() -> list[dict]:
        return store.list()

    @router.post("/profiles")
    def create_profile(body: ProfileIn) -> dict:
        return store.create(name=body.name, color=body.color)

    @router.patch("/profiles/{profile_id}")
    def patch_profile(profile_id: str, body: ProfilePatch) -> dict:
        result = store.patch(profile_id, body.name, body.color)
        if result is None:
            raise HTTPException(404, "profile not found")
        return result

    @router.delete("/profiles/{profile_id}")
    def delete_profile(profile_id: str) -> dict[str, bool]:
        return {"deleted": store.delete(profile_id)}

    @router.delete("/profiles")
    def delete_all_profiles() -> dict[str, int]:
        n = 0
        for p in store.list():
            if store.delete(p["id"]):
                n += 1
        return {"deleted": n}

    @router.post("/profiles/merge")
    def merge_profiles(body: MergeIn) -> dict:
        result = store.merge(body.source_id, body.target_id)
        if result is None:
            raise HTTPException(404, "target profile not found")
        return result

    @router.get("/profiles/{profile_id}/faceprints")
    def list_faceprints(profile_id: str) -> list[dict]:
        return store.faceprints_meta_for(profile_id)

    @router.post("/faceprints/{faceprint_id}/extract")
    def extract_faceprint(faceprint_id: str) -> dict:
        result = store.extract_faceprint(faceprint_id)
        if result is None:
            raise HTTPException(404, "faceprint not found")
        return result

    @router.delete("/faceprints/{faceprint_id}")
    def delete_faceprint(faceprint_id: str) -> dict[str, bool]:
        return {"deleted": store.delete_faceprint(faceprint_id)}

    @router.get("/tuning")
    def get_tuning() -> dict[str, float]:
        return engine.get_tuning()

    @router.patch("/tuning")
    def patch_tuning(body: dict[str, float]) -> dict[str, float]:
        return engine.set_tuning(**body)

    @router.post("/detect", response_model=DetectResponse)
    async def detect_multipart(
        image: UploadFile = File(...),
        remember: bool = True,
    ) -> DetectResponse:
        data = await image.read()
        if not data:
            raise HTTPException(400, "empty image")
        return engine.analyze(data, remember=remember)

    @router.post("/detect/base64", response_model=DetectResponse)
    def detect_base64(body: DetectBase64In) -> DetectResponse:
        raw = body.image
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        try:
            data = base64.b64decode(raw, validate=False)
        except Exception as e:
            raise HTTPException(400, f"invalid base64: {e}") from e
        if not data:
            raise HTTPException(400, "empty image")
        return engine.analyze(data, remember=body.remember)

    return router
