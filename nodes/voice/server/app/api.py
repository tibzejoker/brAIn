"""REST endpoints for profile CRUD and engine control."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .local_capture import CaptureError, LocalCapture, list_input_devices
from .models import CaptureStartIn, ControlIn, MergeIn, ProfileIn, ProfilePatch
from .profiles import ProfileStore
from .ws import SessionHub


def build_router(store: ProfileStore, hub: SessionHub, capture: LocalCapture) -> APIRouter:
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
        deleted = store.delete(profile_id)
        if deleted:
            hub.identity.drop_profile(profile_id)
        return {"deleted": deleted}

    @router.delete("/profiles")
    def delete_all_profiles() -> dict[str, int]:
        n = 0
        for p in store.list():
            if store.delete(p["id"]):
                n += 1
        # Blanket reset is safer than drop_profile loops when wiping
        # everything — guarantees the engine doesn't carry any stale
        # id in its label map after the user hits "clear all".
        hub.identity.reset_label_map()
        return {"deleted": n}

    @router.post("/profiles/merge")
    def merge_profiles(body: MergeIn) -> dict:
        result = store.merge(body.source_id, body.target_id)
        if result is None:
            raise HTTPException(404, "target profile not found")
        # Remap in-memory diarization-label → profile entries that the
        # engine uses during live sessions. Without this, segments for the
        # merged-away source keep getting routed to a now-stale id, and the
        # resolver silently creates a brand-new profile on the next tick
        # — the "merged profile reappeared" bug.
        hub.identity.remap_profile(body.source_id, body.target_id)
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

    @router.get("/capture/devices")
    def capture_devices() -> list[dict]:
        try:
            return list_input_devices()
        except CaptureError as e:
            raise HTTPException(503, str(e)) from e

    @router.get("/capture/status")
    def capture_status() -> dict:
        return capture.status()

    @router.post("/capture/start")
    async def capture_start(body: CaptureStartIn) -> dict:
        try:
            return await capture.start(body.device, body.session_id or "default")
        except CaptureError as e:
            raise HTTPException(503, str(e)) from e

    @router.post("/capture/stop")
    async def capture_stop() -> dict:
        return await capture.stop()

    return router
