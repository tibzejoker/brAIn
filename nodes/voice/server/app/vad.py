"""Silero VAD wrapper using sherpa-onnx (already a dep — no torch needed).

Wraps sherpa_onnx.VoiceActivityDetector around the silero_vad.onnx file we
download in setup_models. Sherpa handles all model-version quirks for us.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000


class SileroVad:
    def __init__(
        self,
        model_path: Path,
        speech_threshold: float = 0.5,
        min_speech_ms: int = 250,
        min_silence_ms: int = 400,
    ) -> None:
        if not model_path.is_file():
            raise FileNotFoundError(f"Silero VAD model not found at {model_path}")

        import sherpa_onnx  # noqa: WPS433

        self._sherpa = sherpa_onnx
        self._model_path = model_path
        self._min_speech_samples = (min_speech_ms * SAMPLE_RATE) // 1000
        self._speech_threshold = speech_threshold
        self._min_silence_seconds = min_silence_ms / 1000.0
        self._min_speech_seconds = min_speech_ms / 1000.0

        self._vad = self._build_vad()

        self._segment_offset_samples = 0
        self._was_speech = False
        self._frames_since_log = 0
        self._completed_buffer: list[tuple[np.ndarray, int, int]] = []

        log.info("Silero VAD loaded via sherpa-onnx (threshold=%.2f, min_speech=%dms, min_silence=%dms)",
                 speech_threshold, min_speech_ms, min_silence_ms)

    def _build_vad(self):
        config = self._sherpa.VadModelConfig()
        config.silero_vad.model = str(self._model_path)
        config.silero_vad.threshold = self._speech_threshold
        config.silero_vad.min_silence_duration = self._min_silence_seconds
        config.silero_vad.min_speech_duration = self._min_speech_seconds
        config.silero_vad.window_size = 512
        config.sample_rate = SAMPLE_RATE
        config.num_threads = 1
        config.provider = "cpu"
        if not config.validate():
            raise RuntimeError("invalid sherpa-onnx VAD config")
        return self._sherpa.VoiceActivityDetector(config, buffer_size_in_seconds=30.0)

    def set_speech_threshold(self, value: float) -> None:
        self._speech_threshold = max(0.05, min(0.95, value))
        self._vad = self._build_vad()
        self._segment_offset_samples = 0
        self._was_speech = False

    @property
    def speech_threshold(self) -> float:
        return self._speech_threshold

    def reset(self) -> None:
        self._vad.reset()
        self._segment_offset_samples = 0
        self._was_speech = False
        self._frames_since_log = 0
        self._completed_buffer = []

    def push(
        self,
        pcm_int16: np.ndarray,
        on_speech_start: Callable[[int], None] | None = None,
        on_speech_end: Callable[[int, int], None] | None = None,
    ) -> None:
        audio = pcm_int16.astype(np.float32) / 32768.0
        self._vad.accept_waveform(audio)

        # Detect speech start (rising edge)
        is_speech_now = self._vad.is_speech_detected()
        if is_speech_now and not self._was_speech and on_speech_start is not None:
            on_speech_start(self._segment_offset_samples)
        self._was_speech = is_speech_now

        # Drain completed segments
        while not self._vad.empty():
            seg = self._vad.front
            start_sample = int(seg.start)
            speech_pcm = (np.asarray(seg.samples, dtype=np.float32) * 32768.0).astype(np.int16)
            end_sample = start_sample + speech_pcm.size
            self._segment_offset_samples = end_sample
            if on_speech_end is not None:
                on_speech_end(start_sample, end_sample)
            self._completed_buffer.append((speech_pcm, start_sample, end_sample))
            self._vad.pop()

        # Periodic log even when no segment is closed yet, so we know VAD is alive.
        self._frames_since_log += 1
        if self._frames_since_log >= 30:
            self._frames_since_log = 0
            log.info("VAD heartbeat — currently_speaking=%s buffered_segments=%d",
                     is_speech_now, len(self._completed_buffer))

    def drain(self) -> list[tuple[np.ndarray, int, int]]:
        out = self._completed_buffer
        self._completed_buffer = []
        return [
            (pcm, start, end) for pcm, start, end in out
            if (end - start) >= self._min_speech_samples
        ]
