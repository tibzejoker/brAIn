"""WebSocket endpoints: audio in, events out."""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .engine import Engine, RawSegment
from .identity import IdentityResolver
from .models import SegmentEvent, SpeakerNewEvent, StatusEvent

log = logging.getLogger(__name__)


class SessionHub:
    """Routes audio frames to the engine and broadcasts events to subscribers."""

    def __init__(self, engine: Engine, identity: IdentityResolver) -> None:
        self._engine = engine
        self._identity = identity
        self._subscribers: dict[str, set[WebSocket]] = defaultdict(set)
        self._active_session: str | None = None
        self._consumer_task: asyncio.Task[None] | None = None

    @property
    def active_session(self) -> str | None:
        return self._active_session

    @property
    def engine(self) -> Engine:
        return self._engine

    async def start_session(self, session_id: str) -> None:
        if self._active_session == session_id:
            return
        self._identity.reset_label_map()
        await self._engine.start(session_id)
        self._active_session = session_id
        self._consumer_task = asyncio.create_task(self._consume())
        await self._broadcast(session_id, StatusEvent(state="listening"))

    async def stop_session(self) -> None:
        if self._active_session is None:
            return
        sid = self._active_session
        await self._engine.stop()
        self._active_session = None
        if self._consumer_task is not None:
            self._consumer_task.cancel()
        await self._broadcast(sid, StatusEvent(state="idle"))

    async def push_audio(self, frame: bytes) -> None:
        await self._engine.push_audio(frame)

    def subscribe(self, session_id: str, ws: WebSocket) -> None:
        self._subscribers[session_id].add(ws)

    def unsubscribe(self, session_id: str, ws: WebSocket) -> None:
        self._subscribers[session_id].discard(ws)
        if not self._subscribers[session_id]:
            self._subscribers.pop(session_id, None)

    async def _consume(self) -> None:
        try:
            async for raw in self._engine.segments():
                await self._handle_segment(raw)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("engine consumer crashed")

    async def _handle_segment(self, raw: RawSegment) -> None:
        sid = self._active_session
        if sid is None:
            return

        identity = self._identity.resolve(raw.pcm, raw.sample_rate, raw.diar_label)
        if identity is None:
            return
        speaker_id, name = identity.speaker_id, identity.name
        confidence, provisional, is_new = identity.confidence, identity.provisional, identity.is_new

        if is_new:
            await self._broadcast(sid, SpeakerNewEvent(speaker_id=speaker_id, name=name))

        await self._broadcast(
            sid,
            SegmentEvent(
                session_id=sid,
                speaker_id=speaker_id,
                name=name,
                text=raw.text,
                t_start=raw.t_start,
                t_end=raw.t_end,
                provisional=provisional,
                confidence=confidence,
            ),
        )

    async def _broadcast(self, session_id: str, event: Any) -> None:
        payload = event.model_dump_json() if hasattr(event, "model_dump_json") else json.dumps(event)
        dead: list[WebSocket] = []
        for ws in self._subscribers.get(session_id, set()):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(session_id, ws)


async def audio_endpoint(ws: WebSocket, hub: SessionHub, session_id: str) -> None:
    await ws.accept()
    await hub.start_session(session_id)
    log.info("audio ws opened for session=%s", session_id)
    bytes_received = 0
    try:
        while True:
            frame = await ws.receive_bytes()
            bytes_received += len(frame)
            await hub.push_audio(frame)
    except WebSocketDisconnect:
        log.info("audio ws disconnected (received %d bytes total)", bytes_received)
    except Exception:
        log.exception("audio ws error after %d bytes", bytes_received)


async def events_endpoint(ws: WebSocket, hub: SessionHub, session_id: str) -> None:
    await ws.accept()
    hub.subscribe(session_id, ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe(session_id, ws)
