"""REST endpoints for profile CRUD and engine control."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .models import ControlIn, MergeIn, ProfileIn, ProfilePatch
from .profiles import ProfileStore
from .ws import SessionHub


def build_router(store: ProfileStore, hub: SessionHub) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["voice"])

    @router.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "active_session": hub.active_session or ""}

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

    @router.get("/profiles/{profile_id}/voiceprints")
    def list_voiceprints(profile_id: str) -> list[dict]:
        return store.voiceprints_meta_for(profile_id)

    @router.post("/voiceprints/{voiceprint_id}/extract")
    def extract_voiceprint(voiceprint_id: str) -> dict:
        result = store.extract_voiceprint(voiceprint_id)
        if result is None:
            raise HTTPException(404, "voiceprint not found")
        return result

    @router.delete("/voiceprints/{voiceprint_id}")
    def delete_voiceprint(voiceprint_id: str) -> dict[str, bool]:
        return {"deleted": store.delete_voiceprint(voiceprint_id)}

    @router.post("/control")
    async def control(body: ControlIn) -> dict[str, str]:
        if body.action == "start":
            sid = body.session_id or "default"
            await hub.start_session(sid)
            return {"state": "listening", "session_id": sid}
        if body.action == "stop":
            await hub.stop_session()
            return {"state": "idle"}
        return {"state": "listening" if hub.active_session else "idle",
                "session_id": hub.active_session or ""}

    @router.get("/tuning")
    def get_tuning() -> dict[str, float]:
        return hub.engine.get_tuning()

    @router.patch("/tuning")
    def patch_tuning(body: dict[str, float]) -> dict[str, float]:
        return hub.engine.set_tuning(**body)

    return router
