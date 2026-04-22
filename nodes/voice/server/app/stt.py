"""faster-whisper STT wrapper (thin sync interface — call from a worker thread)."""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


class FasterWhisperStt:
    def __init__(
        self,
        model_size: str = "tiny",
        language: str = "fr",
        download_root: Path | None = None,
        compute_type: str = "int8",
    ) -> None:
        from faster_whisper import WhisperModel  # noqa: WPS433

        log.info("loading faster-whisper model=%s compute=%s", model_size, compute_type)
        self._model = WhisperModel(
            model_size,
            device="cpu",
            compute_type=compute_type,
            download_root=str(download_root) if download_root else None,
        )
        self._language = language

    def transcribe(self, pcm_int16: np.ndarray, sample_rate: int = 16000) -> str:
        if sample_rate != 16000:
            raise ValueError("faster-whisper pipeline expects 16 kHz input")
        audio = pcm_int16.astype(np.float32) / 32768.0
        segments, _ = self._model.transcribe(
            audio,
            language=self._language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()
