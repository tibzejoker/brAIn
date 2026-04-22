"""Engine implementations.

Phase 1 `StubEngine` — silence-based fake diarization for UI validation.
Phase 2 `VadSttEngine` — real pipeline: Silero VAD → faster-whisper + WeSpeaker.

Switch via `VOICE_ENGINE` env var: `stub` (default) | `real`.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

import numpy as np

from .config import settings
from .identity import IdentityResolver

log = logging.getLogger(__name__)


@dataclass(slots=True)
class RawSegment:
    """Raw output from the diarization engine (ephemeral spk label)."""
    text: str
    t_start: float
    t_end: float
    diar_label: str
    pcm: np.ndarray | None
    sample_rate: int
    confidence: float


class Engine:
    async def push_audio(self, frame: bytes) -> None:
        raise NotImplementedError

    def segments(self) -> AsyncIterator[RawSegment]:
        raise NotImplementedError

    async def start(self, session_id: str) -> None:
        raise NotImplementedError

    async def stop(self) -> None:
        raise NotImplementedError

    def get_tuning(self) -> dict[str, float]:
        return {}

    def set_tuning(self, **kwargs: float) -> dict[str, float]:  # noqa: ARG002
        return self.get_tuning()


class StubEngine(Engine):
    """Phase 1 stub — fake diarization via silence-based speaker rotation."""

    SAMPLE_RATE = 16000
    SILENCE_RMS = 400
    SWITCH_GAP_S = 1.2
    MIN_SEGMENT_S = 1.0
    MAX_SEGMENT_S = 8.0
    FAKE_SPEAKER_POOL = ["spk_0", "spk_1", "spk_2", "spk_3"]

    def __init__(self, identity: IdentityResolver) -> None:
        self._identity = identity
        self._queue: asyncio.Queue[RawSegment] = asyncio.Queue(maxsize=128)
        self._session_id: str | None = None
        self._t0: float | None = None

        self._samples_seen = 0
        self._segment_start_sample: int | None = None
        self._last_speech_sample: int = 0
        self._current_speaker_idx = 0
        self._silence_since_last_speech_samples = 0

    async def start(self, session_id: str) -> None:
        self._session_id = session_id
        self._t0 = time.monotonic()
        self._samples_seen = 0
        self._segment_start_sample = None
        self._last_speech_sample = 0
        self._current_speaker_idx = 0
        self._silence_since_last_speech_samples = 0

    async def stop(self) -> None:
        self._flush_segment(force=True)
        self._session_id = None

    async def push_audio(self, frame: bytes) -> None:
        if self._session_id is None:
            return
        samples = np.frombuffer(frame, dtype=np.int16)
        if samples.size == 0:
            return
        rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
        is_speech = rms > self.SILENCE_RMS

        if is_speech:
            if self._segment_start_sample is None:
                self._segment_start_sample = self._samples_seen
            self._last_speech_sample = self._samples_seen + samples.size
            self._silence_since_last_speech_samples = 0
        else:
            self._silence_since_last_speech_samples += samples.size

        self._samples_seen += samples.size

        seg_duration_s = (
            (self._samples_seen - self._segment_start_sample) / self.SAMPLE_RATE
            if self._segment_start_sample is not None
            else 0.0
        )
        gap_s = self._silence_since_last_speech_samples / self.SAMPLE_RATE

        if self._segment_start_sample is not None and (
            (gap_s >= self.SWITCH_GAP_S and seg_duration_s >= self.MIN_SEGMENT_S)
            or seg_duration_s >= self.MAX_SEGMENT_S
        ):
            self._flush_segment()
            if gap_s >= self.SWITCH_GAP_S:
                self._current_speaker_idx = (
                    self._current_speaker_idx + 1
                ) % len(self.FAKE_SPEAKER_POOL)

    def _flush_segment(self, force: bool = False) -> None:
        if self._segment_start_sample is None:
            return
        t_start = self._segment_start_sample / self.SAMPLE_RATE
        t_end = self._last_speech_sample / self.SAMPLE_RATE
        duration = t_end - t_start
        if not force and duration < self.MIN_SEGMENT_S:
            self._segment_start_sample = None
            return
        label = self.FAKE_SPEAKER_POOL[self._current_speaker_idx]
        seg = RawSegment(
            text=f"(stub) {label} spoke for {duration:.1f}s",
            t_start=t_start,
            t_end=t_end,
            diar_label=label,
            pcm=None,
            sample_rate=self.SAMPLE_RATE,
            confidence=0.5,
        )
        try:
            self._queue.put_nowait(seg)
        except asyncio.QueueFull:
            pass
        self._segment_start_sample = None

    async def segments(self) -> AsyncIterator[RawSegment]:
        while True:
            seg = await self._queue.get()
            yield seg


class VadSttEngine(Engine):
    """Phase 2: Silero VAD → per-segment (faster-whisper STT + WeSpeaker embedding).

    No frame-level diarization — one speaker per VAD segment. The persistent
    identity layer still matches the segment's embedding against known profiles,
    so turn-taking with pauses works end-to-end.
    """

    SAMPLE_RATE = 16000

    def __init__(self, identity: IdentityResolver) -> None:
        from .embedder import SherpaSpeakerEmbedder
        from .stt import FasterWhisperStt
        from .vad import SileroVad

        self._identity = identity
        self._queue: asyncio.Queue[RawSegment] = asyncio.Queue(maxsize=128)
        self._session_id: str | None = None

        models = settings.models_dir
        self._vad = SileroVad(model_path=models / "silero_vad.onnx")
        self._stt = FasterWhisperStt(
            model_size=settings.stt_model,
            language=settings.language,
            download_root=models / "whisper",
        )
        embedder_path = models / settings.embedding_model_file
        self._embedder = SherpaSpeakerEmbedder(model_path=embedder_path)
        self._identity.set_embedder(self._embedder)

    async def start(self, session_id: str) -> None:
        self._session_id = session_id
        self._vad.reset()
        self._frames_received = 0
        self._samples_total = 0

    async def stop(self) -> None:
        log.info("VadSttEngine.stop — frames=%d samples=%d (%.1fs of audio)",
                 self._frames_received, self._samples_total,
                 self._samples_total / self.SAMPLE_RATE)
        self._session_id = None

    def get_tuning(self) -> dict[str, float]:
        return {
            "vad_speech_threshold": self._vad.speech_threshold,
            "match_threshold": settings.match_threshold,
            "uncertain_threshold": settings.uncertain_threshold,
            "ema_decay": settings.ema_decay,
            "min_segment_ms": float(settings.min_segment_ms),
        }

    def set_tuning(self, **kwargs: float) -> dict[str, float]:
        if "vad_speech_threshold" in kwargs:
            self._vad.set_speech_threshold(float(kwargs["vad_speech_threshold"]))
        if "match_threshold" in kwargs:
            settings.match_threshold = float(kwargs["match_threshold"])
        if "uncertain_threshold" in kwargs:
            settings.uncertain_threshold = float(kwargs["uncertain_threshold"])
        if "ema_decay" in kwargs:
            settings.ema_decay = float(kwargs["ema_decay"])
        if "min_segment_ms" in kwargs:
            settings.min_segment_ms = int(kwargs["min_segment_ms"])
        return self.get_tuning()

    async def push_audio(self, frame: bytes) -> None:
        if self._session_id is None:
            return
        samples = np.frombuffer(frame, dtype=np.int16)
        if samples.size == 0:
            return
        self._frames_received += 1
        self._samples_total += samples.size
        if self._frames_received == 1 or self._frames_received % 50 == 0:
            rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
            log.info("audio frame #%d (%d samples, rms=%.0f, total=%.1fs)",
                     self._frames_received, samples.size, rms,
                     self._samples_total / self.SAMPLE_RATE)

        def _on_speech_start(start_sample: int) -> None:
            log.info("VAD speech_start at sample %d (%.2fs)",
                     start_sample, start_sample / self.SAMPLE_RATE)

        def _on_speech_end(start_sample: int, end_sample: int) -> None:
            log.info("VAD speech_end %.2fs–%.2fs (duration %.2fs)",
                     start_sample / self.SAMPLE_RATE,
                     end_sample / self.SAMPLE_RATE,
                     (end_sample - start_sample) / self.SAMPLE_RATE)

        self._vad.push(samples, on_speech_start=_on_speech_start, on_speech_end=_on_speech_end)
        for pcm, start_sample, end_sample in self._vad.drain():
            t_start = start_sample / self.SAMPLE_RATE
            t_end = end_sample / self.SAMPLE_RATE
            log.info("dispatching segment %.2fs–%.2fs to STT", t_start, t_end)
            asyncio.create_task(self._process_segment(pcm, t_start, t_end))

    async def _process_segment(self, pcm: np.ndarray, t_start: float, t_end: float) -> None:
        try:
            t0 = time.monotonic()
            loop = asyncio.get_running_loop()
            text = await loop.run_in_executor(None, self._stt.transcribe, pcm)
            log.info("STT %.2fs–%.2fs done in %.2fs → %r",
                     t_start, t_end, time.monotonic() - t0, text)
            if not text:
                return
            seg = RawSegment(
                text=text,
                t_start=t_start,
                t_end=t_end,
                diar_label="vad",
                pcm=pcm,
                sample_rate=self.SAMPLE_RATE,
                confidence=0.9,
            )
            try:
                self._queue.put_nowait(seg)
            except asyncio.QueueFull:
                log.warning("segment queue full — dropping segment")
        except Exception:
            log.exception("segment processing failed")

    async def segments(self) -> AsyncIterator[RawSegment]:
        while True:
            seg = await self._queue.get()
            yield seg


def build_engine(identity: IdentityResolver) -> Engine:
    choice = os.environ.get("VOICE_ENGINE", "stub").lower()
    if choice == "real":
        log.info("building VadSttEngine (real pipeline)")
        return VadSttEngine(identity)
    log.info("building StubEngine (no ML, silence-based fake diarization)")
    return StubEngine(identity)
