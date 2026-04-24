"""Correlator: "who talks to whom?"

Triggered by each finalized voice segment. Looks up gaze events from the
same linked person in the correlation window around the segment, picks
the dominant gaze target, and records an intent record.

Target resolution:
    - If the dominant gaze event target was 'profile' and that face is
      linked to a person → intent target = that person.
    - If 'camera' was dominant → target_kind='camera' (speaker addresses
      the viewer/camera directly).
    - If 'scene' was dominant → target_kind='scene', carry the Moondream
      description if any.
    - Otherwise → target_kind='unknown' (we don't have a clean read on
      where the speaker was looking during their segment).

The confidence is `count_dominant / count_total` over the gaze events in
the window. Very conservative — one gaze event and we only emit if it
was consistent across the segment.
"""
from __future__ import annotations

import asyncio
import logging
from collections import Counter
from dataclasses import dataclass

from .persons import PersonStore
from .timeline import Timeline, VoiceSegment

log = logging.getLogger(__name__)


@dataclass(slots=True)
class CorrelatorConfig:
    pre_s: float
    post_s: float


class IntentCorrelator:
    def __init__(
        self,
        store: PersonStore,
        timeline: Timeline,
        cfg: CorrelatorConfig,
        broadcast_cb,  # callable(dict) → awaitable; called with the intent dict after DB insert
    ) -> None:
        self._store = store
        self._timeline = timeline
        self._cfg = cfg
        self._broadcast = broadcast_cb

    async def on_segment(self, seg: VoiceSegment) -> None:
        """Called after a finalized voice segment lands in the timeline."""
        if not seg.person_id:
            log.debug("segment from unlinked voice profile %s — skipping", seg.voice_profile_id)
            return

        start = seg.ts - self._cfg.pre_s
        end = seg.ts + self._cfg.post_s
        gaze_events = self._timeline.gaze_events_for(seg.person_id, start, end)

        target_kind = "unknown"
        target_person_id = None
        target_gaze_pid = None
        target_name = None
        description = None
        confidence = 0.0

        if gaze_events:
            # Build a dominant-target vote. Each gaze event contributes a key:
            #  person target → ('person', person_id)
            #  camera      → ('camera', None)
            #  scene       → ('scene', None)
            keys: list[tuple[str, str | None]] = []
            for e in gaze_events:
                if e.target_kind == "profile":
                    if e.target_person_id:
                        keys.append(("person", e.target_person_id))
                    else:
                        # Unlinked face — still note the gaze target's face id so the
                        # UI can surface it and the user can link on the fly.
                        keys.append(("face", e.target_gaze_profile_id))
                elif e.target_kind == "camera":
                    keys.append(("camera", None))
                elif e.target_kind == "scene":
                    keys.append(("scene", None))
            if keys:
                (kind, ref), count = Counter(keys).most_common(1)[0]
                confidence = count / len(keys)
                if kind == "person":
                    target_kind = "person"
                    target_person_id = ref
                    person = self._store.get(ref) if ref else None
                    if person:
                        target_name = person["name"]
                        target_gaze_pid = person.get("gaze_profile_id")
                elif kind == "face":
                    # Unlinked face was the dominant gaze target.
                    target_kind = "person"
                    target_gaze_pid = ref
                elif kind == "camera":
                    target_kind = "camera"
                elif kind == "scene":
                    target_kind = "scene"
                    # Grab the description from the most recent scene event in the
                    # window (descriptions come from Moondream on gaze `describe=true`).
                    for ev in reversed(gaze_events):
                        if ev.target_kind == "scene" and ev.description:
                            description = ev.description
                            break

        # Pull the speaker's display info from the linked person; fall back
        # to whatever the voice engine carries.
        source = self._store.get(seg.person_id)
        source_name = source["name"] if source else seg.voice_name or None

        intent_id = self._store.record_intent(
            source_person_id=seg.person_id,
            source_voice_profile_id=seg.voice_profile_id,
            source_name=source_name,
            target_kind=target_kind,
            target_person_id=target_person_id,
            target_gaze_profile_id=target_gaze_pid,
            target_name=target_name if target_kind == "person" else (description if target_kind == "scene" else None),
            text=seg.text,
            t_start=seg.t_start,
            t_end=seg.t_end,
            confidence=confidence,
        )
        intent = {
            "id": intent_id,
            "source_person_id": seg.person_id,
            "source_voice_profile_id": seg.voice_profile_id,
            "source_name": source_name,
            "target_kind": target_kind,
            "target_person_id": target_person_id,
            "target_gaze_profile_id": target_gaze_pid,
            "target_name": target_name if target_kind == "person" else description,
            "text": seg.text,
            "t_start": seg.t_start,
            "t_end": seg.t_end,
            "confidence": confidence,
        }
        log.info(
            "intent #%d  %s → %s (%s conf=%.2f)  %r",
            intent_id, source_name, target_name or target_kind, target_kind, confidence, seg.text,
        )
        result = self._broadcast(intent)
        if asyncio.iscoroutine(result):
            await result
