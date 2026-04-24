"""REST + WebSocket API owned by the intent node.

Only routes under /api/persons, /api/intents and /api/timeline are handled
here. Everything else is the transparent proxy (see proxy.py).
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from .models import PersonIn, PersonPatch
from .persons import PersonStore
from .timeline import Timeline

log = logging.getLogger(__name__)


class IntentBroadcaster:
    """Push live intent records to connected /ws/intents subscribers."""

    def __init__(self) -> None:
        self._subs: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subs.add(ws)

    async def unsubscribe(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subs.discard(ws)

    async def push(self, intent: dict) -> None:
        payload = json.dumps(intent)
        dead: list[WebSocket] = []
        async with self._lock:
            for ws in self._subs:
                try:
                    await ws.send_text(payload)
                except Exception:  # noqa: BLE001
                    dead.append(ws)
            for ws in dead:
                self._subs.discard(ws)


def build_router(
    store: PersonStore, timeline: Timeline, broadcaster: IntentBroadcaster,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/persons")
    def list_persons() -> list[dict]:
        return store.list()

    @router.post("/api/persons")
    def create_person(body: PersonIn) -> dict:
        return store.create(
            name=body.name,
            color=body.color,
            voice_profile_id=body.voice_profile_id,
            gaze_profile_id=body.gaze_profile_id,
        )

    @router.patch("/api/persons/{person_id}")
    def patch_person(person_id: str, body: PersonPatch) -> dict:
        result = store.patch(
            person_id, body.name, body.color, body.voice_profile_id, body.gaze_profile_id,
        )
        if result is None:
            raise HTTPException(404, "person not found")
        return result

    @router.delete("/api/persons/{person_id}")
    def delete_person(person_id: str) -> dict[str, bool]:
        return {"deleted": store.delete(person_id)}

    @router.get("/api/intents")
    def list_intents(limit: int = 200, since_id: int | None = None) -> list[dict]:
        return store.list_intents(limit=limit, since_id=since_id)

    @router.delete("/api/intents")
    def clear_intents() -> dict[str, int]:
        return {"deleted": store.clear_intents()}

    @router.get("/api/timeline")
    def get_timeline(window_s: float = 60.0) -> dict:
        voice, gaze = timeline.snapshot(window_s)
        return {
            "now": __import__("time").time(),
            "window_s": window_s,
            "voice": [
                {
                    "ts": s.ts, "person_id": s.person_id,
                    "voice_profile_id": s.voice_profile_id,
                    "voice_name": s.voice_name, "text": s.text,
                    "t_start": s.t_start, "t_end": s.t_end,
                    "confidence": s.confidence, "provisional": s.provisional,
                }
                for s in voice
            ],
            "gaze": [
                {
                    "ts": e.ts, "target_kind": e.target_kind,
                    "source_gaze_profile_id": e.source_gaze_profile_id,
                    "target_gaze_profile_id": e.target_gaze_profile_id,
                    "source_person_id": e.source_person_id,
                    "target_person_id": e.target_person_id,
                    "description": e.description,
                    "gaze_x": e.gaze_x, "gaze_y": e.gaze_y,
                }
                for e in gaze
            ],
        }

    @router.websocket("/ws/intents")
    async def ws_intents(ws: WebSocket) -> None:
        await ws.accept()
        await broadcaster.subscribe(ws)
        try:
            while True:
                # Client-to-server messages are ignored; we only use the
                # receive to detect a clean disconnect.
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await broadcaster.unsubscribe(ws)

    return router
