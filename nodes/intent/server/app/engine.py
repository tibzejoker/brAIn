"""Correlator: "who talks to whom?"

Each gaze event carries a state transition — the source person started
looking at X at that timestamp, and stays on X until the next event
(or, after `state_freshness_s` with no events, we stop trusting the
state and consider them offscreen). When a voice segment finalises we
compute the overlap duration of the segment with every "state interval"
for the speaker and pick the target that covered the most time.

Target resolution:
    - 'profile' target linked to a person → intent target = that person
    - 'camera' → target_kind='camera'
    - 'scene' → target_kind='scene' with Moondream description if any
    - no state active during the segment (gaze webcam off, subject
      offscreen, ...) → target_kind='unknown'

Confidence is `overlap_winner / total_overlap` — if 80% of the segment
the subject looked at camera and 20% at a person, confidence=0.8 on
'camera'.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time as time_mod
from collections import defaultdict
from dataclasses import dataclass

from .persons import PersonStore
from .timeline import Timeline, VoiceSegment

log = logging.getLogger(__name__)


@dataclass(slots=True)
class CorrelatorConfig:
    pre_s: float
    post_s: float
    # If the latest gaze event for a speaker is older than this, we treat
    # "no new transition" as "offscreen / unknown" rather than extending
    # the last state forever. Matches the UI's OFFSCREEN_TIMEOUT_S so
    # the intent verdict and the timeline band agree visually.
    state_freshness_s: float = 2.0
    # Gaze events lag behind the actual eye movement (detection FPS +
    # stability frames). Shift intervals earlier by this to credit a
    # transition to the moment the eye actually moved, not the moment
    # the gaze engine committed.
    state_lag_s: float = 1.0


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

        # Voice engine's `ts_end` is the wall-clock when the audio ended
        # (before STT latency). The speech interval is roughly [ts_end -
        # duration, ts_end]; we pad with pre_s/post_s to absorb skew.
        duration = max(0.0, seg.t_end - seg.t_start)
        ref = seg.ts_end if seg.ts_end is not None else seg.ts
        seg_start = ref - duration - self._cfg.pre_s
        seg_end = ref + self._cfg.post_s

        # Collect every gaze event for this speaker within a generous
        # lookback — we need the latest transition that PRECEDED the
        # speech to know the state at seg_start, even if no new event
        # fired during the speech itself.
        lookback_s = max(self._timeline.retention_s, 120.0)
        all_events = sorted(
            self._timeline.gaze_events_for(seg.person_id, ref - lookback_s, seg_end),
            key=lambda e: e.ts,
        )

        # Turn events into (start, end, event) intervals capped by
        # `state_freshness_s` so a committed state doesn't extend forever
        # when the subject goes offscreen.
        # Each interval is backdated by `state_lag_s` to account for the
        # detection-plus-stability delay: a transition committed at T was
        # physically in place by roughly T − state_lag_s.
        freshness = self._cfg.state_freshness_s
        lag = self._cfg.state_lag_s
        intervals: list[tuple[float, float, object]] = []
        now_ts = time_mod.time()
        for i, ev in enumerate(all_events):
            next_ts = all_events[i + 1].ts if i + 1 < len(all_events) else now_ts
            start = ev.ts - lag
            end = min(next_ts - lag, ev.ts + freshness)
            if end <= start:
                continue
            intervals.append((start, end, ev))

        # Score by total overlap duration with the speech interval.
        overlap: dict[tuple[str, str | None], float] = defaultdict(float)
        winning_ev: dict[tuple[str, str | None], object] = {}
        for iv_start, iv_end, ev in intervals:
            lo = max(iv_start, seg_start)
            hi = min(iv_end, seg_end)
            if hi <= lo:
                continue
            span = hi - lo
            if ev.target_kind == "profile":
                if ev.target_person_id:
                    key: tuple[str, str | None] = ("person", ev.target_person_id)
                else:
                    key = ("face", ev.target_gaze_profile_id)
            elif ev.target_kind == "camera":
                key = ("camera", None)
            elif ev.target_kind == "scene":
                key = ("scene", None)
            else:
                continue
            overlap[key] += span
            winning_ev[key] = ev

        target_kind = "unknown"
        target_person_id = None
        target_gaze_pid = None
        target_name = None
        description = None
        confidence = 0.0
        seg_span = max(1e-6, seg_end - seg_start)

        if overlap:
            best_key = max(overlap, key=lambda k: overlap[k])
            confidence = overlap[best_key] / seg_span
            kind, ref_val = best_key
            best_ev = winning_ev[best_key]
            if kind == "person":
                target_kind = "person"
                target_person_id = ref_val
                person = self._store.get(ref_val) if ref_val else None
                if person:
                    target_name = person["name"]
                    target_gaze_pid = person.get("gaze_profile_id")
            elif kind == "face":
                target_kind = "person"
                target_gaze_pid = ref_val
            elif kind == "camera":
                target_kind = "camera"
            elif kind == "scene":
                target_kind = "scene"
                description = getattr(best_ev, "description", None)

        # Pull the speaker's display info from the linked person; fall back
        # to whatever the voice engine carries.
        source = self._store.get(seg.person_id)
        source_name = source["name"] if source else seg.voice_name or None

        speech_ts: str | None = None
        if seg.ts_end is not None:
            speech_ts = dt.datetime.fromtimestamp(
                seg.ts_end, tz=dt.UTC,
            ).replace(microsecond=0).isoformat()
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
            speech_ts=speech_ts,
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
        log.info(
            "  corr  seg=[%.2f,%.2f] ref=%.2f (ts_end=%s) overlaps=%s",
            seg_start, seg_end, ref,
            seg.ts_end, dict(overlap),
        )
        log.info(
            "  events in window: %s",
            [
                (round(ev.ts, 2), ev.target_kind, ev.target_gaze_profile_id or ev.target_person_id)
                for iv_s, iv_e, ev in intervals
                if iv_e >= seg_start and iv_s <= seg_end
            ],
        )
        result = self._broadcast(intent)
        if asyncio.iscoroutine(result):
            await result
