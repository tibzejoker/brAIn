"""Background tasks bridging upstream voice + gaze servers into the timeline.

VoiceClient
    Opens a persistent WebSocket to /ws/events on the voice server, parses
    SegmentEvent payloads, resolves voice_profile_id → person_id via the
    PersonStore, and pushes into the timeline. Sends the initial "start"
    control so the voice engine begins listening under the configured
    session id.

GazeEventPoller
    Polls /api/events?since_id=N on the gaze server, resolves
    source/target gaze_profile_id → person_id, and pushes into the same
    timeline.

Both are self-healing — disconnection or HTTP error triggers a backoff
and retry rather than terminating the background tasks.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time as time_mod

import httpx
import websockets

from .persons import PersonStore
from .timeline import GazeEvent, Timeline, VoiceSegment

log = logging.getLogger(__name__)


class VoiceClient:
    def __init__(
        self,
        voice_url: str,
        session_id: str,
        store: PersonStore,
        timeline: Timeline,
        intent_cb,  # callable(VoiceSegment) -> None | Awaitable, invoked after append
    ) -> None:
        self._voice_url = voice_url.rstrip("/")
        self._session = session_id
        self._store = store
        self._timeline = timeline
        self._cb = intent_cb
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="voice-client")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        ws_url = self._voice_url.replace("http://", "ws://").replace("https://", "wss://")
        url = f"{ws_url}/ws/events?session_id={self._session}"
        backoff = 1.0
        while not self._stop.is_set():
            try:
                log.info("voice ws → %s", url)
                async with websockets.connect(url, ping_interval=20) as ws:
                    # Kick the voice engine so it actually emits.
                    await self._ensure_listening()
                    backoff = 1.0
                    async for raw in ws:
                        try:
                            self._ingest(raw)
                        except Exception:  # noqa: BLE001
                            log.exception("voice event ingest failed")
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("voice ws disconnected: %s — retrying in %.1fs", e, backoff)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, 30.0)

    async def _ensure_listening(self) -> None:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    f"{self._voice_url}/api/control",
                    json={"action": "start", "session_id": self._session},
                )
        except httpx.HTTPError as e:
            log.warning("voice /api/control start failed: %s (continuing anyway)", e)

    def _ingest(self, raw: str | bytes) -> None:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        event = json.loads(raw)
        if event.get("type") != "segment":
            return
        voice_pid = event.get("speaker_id")
        person = self._store.find_by_voice(voice_pid) if voice_pid else None
        seg = VoiceSegment(
            ts=time_mod.time(),
            voice_profile_id=voice_pid or "",
            voice_name=event.get("name") or "",
            text=event.get("text") or "",
            t_start=float(event.get("t_start") or 0.0),
            t_end=float(event.get("t_end") or 0.0),
            confidence=float(event.get("confidence") or 0.0),
            provisional=bool(event.get("provisional") or False),
            person_id=person["id"] if person else None,
        )
        self._timeline.add_voice(seg)
        # Only fire correlator for finalized (non-provisional) segments.
        if not seg.provisional:
            result = self._cb(seg)
            if asyncio.iscoroutine(result):
                asyncio.create_task(result)


class GazeEventPoller:
    def __init__(
        self, gaze_url: str, interval_s: float, store: PersonStore, timeline: Timeline,
    ) -> None:
        self._url = gaze_url.rstrip("/")
        self._interval = interval_s
        self._store = store
        self._timeline = timeline
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="gaze-poller")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        async with httpx.AsyncClient(timeout=10.0) as client:
            while not self._stop.is_set():
                try:
                    params = {"limit": 100}
                    if self._timeline.gaze_cursor:
                        params["since_id"] = self._timeline.gaze_cursor
                    resp = await client.get(f"{self._url}/api/events", params=params)
                    resp.raise_for_status()
                    for row in resp.json():
                        self._ingest(row)
                except httpx.HTTPError as e:
                    log.debug("gaze poll failed: %s", e)
                except Exception:  # noqa: BLE001
                    log.exception("gaze event ingest failed")
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=self._interval)
                except asyncio.TimeoutError:
                    pass

    def _ingest(self, row: dict) -> None:
        ev_id = int(row.get("id") or 0)
        if ev_id > self._timeline.gaze_cursor:
            self._timeline.gaze_cursor = ev_id
        source_gid = row.get("source_profile_id")
        target_gid = row.get("target_profile_id")
        source_p = self._store.find_by_gaze(source_gid) if source_gid else None
        target_p = self._store.find_by_gaze(target_gid) if target_gid else None
        ev = GazeEvent(
            ts=time_mod.time(),
            target_kind=row.get("target_type") or "unknown",
            source_gaze_profile_id=source_gid,
            target_gaze_profile_id=target_gid,
            description=row.get("description"),
            gaze_x=row.get("gaze_x"),
            gaze_y=row.get("gaze_y"),
            source_person_id=source_p["id"] if source_p else None,
            target_person_id=target_p["id"] if target_p else None,
        )
        self._timeline.add_gaze(ev)
