"""In-memory ring buffer of voice segments + gaze events, keyed by person.

Segments/events are stored raw and resolved to person ids at write time
(via PersonStore link lookups). An unresolved segment (voice profile not
linked to any person yet) is still kept — the correlator will skip it
until the user links the profiles.
"""
from __future__ import annotations

import threading
import time as time_mod
from collections import deque
from dataclasses import dataclass, field


@dataclass(slots=True)
class VoiceSegment:
    # Received-at-wall-clock (epoch seconds) — used for retention cleanup.
    ts: float
    voice_profile_id: str
    voice_name: str
    text: str
    # Segment time offsets from the voice session's t=0.
    t_start: float
    t_end: float
    confidence: float
    provisional: bool
    person_id: str | None = None  # resolved at ingest


@dataclass(slots=True)
class GazeEvent:
    ts: float                # wall-clock epoch
    # target_kind is 'camera' | 'profile' | 'scene'
    target_kind: str
    source_gaze_profile_id: str | None    # the face that's looking
    target_gaze_profile_id: str | None    # the face being looked at (if profile)
    description: str | None               # scene description if target_kind=scene
    gaze_x: float | None = None
    gaze_y: float | None = None
    source_person_id: str | None = None
    target_person_id: str | None = None


@dataclass(slots=True)
class Timeline:
    retention_s: float
    voice: deque[VoiceSegment] = field(default_factory=deque)
    gaze: deque[GazeEvent] = field(default_factory=deque)
    lock: threading.Lock = field(default_factory=threading.Lock)
    # Tracks the highest gaze event id already pulled from gaze /api/events
    # so the poller can request only new records.
    gaze_cursor: int = 0

    def add_voice(self, seg: VoiceSegment) -> None:
        with self.lock:
            self.voice.append(seg)
            self._prune()

    def add_gaze(self, ev: GazeEvent) -> None:
        with self.lock:
            self.gaze.append(ev)
            self._prune()

    def snapshot(self, window_s: float | None = None) -> tuple[list[VoiceSegment], list[GazeEvent]]:
        cutoff = time_mod.time() - (window_s if window_s is not None else self.retention_s)
        with self.lock:
            v = [s for s in self.voice if s.ts >= cutoff]
            g = [e for e in self.gaze if e.ts >= cutoff]
        return v, g

    def _prune(self) -> None:
        cutoff = time_mod.time() - self.retention_s
        while self.voice and self.voice[0].ts < cutoff:
            self.voice.popleft()
        while self.gaze and self.gaze[0].ts < cutoff:
            self.gaze.popleft()

    def gaze_events_for(
        self, source_person_id: str, start: float, end: float,
    ) -> list[GazeEvent]:
        with self.lock:
            return [
                e for e in self.gaze
                if e.source_person_id == source_person_id and start <= e.ts <= end
            ]
