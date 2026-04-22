"""Speaker embedding via sherpa-onnx.

sherpa-onnx ships C++ feature extraction baked into the model wrapper, so we
don't have to hand-roll fbank/mel computation. Works with any speaker-embedding
ONNX from k2-fsa/sherpa-onnx releases (WeSpeaker, 3D-Speaker, NeMo TitaNet).
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from .identity import Embedder

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000
MIN_SEGMENT_SAMPLES = SAMPLE_RATE  # 1s floor


class SherpaSpeakerEmbedder(Embedder):
    def __init__(self, model_path: Path) -> None:
        if not model_path.is_file():
            raise FileNotFoundError(f"speaker embedder model not found at {model_path}")
        import sherpa_onnx  # noqa: WPS433

        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(model_path),
            num_threads=2,
            debug=False,
            provider="cpu",
        )
        if not config.validate():
            raise RuntimeError("invalid SpeakerEmbeddingExtractor config")
        self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        log.info("loaded speaker embedder from %s (dim=%d)", model_path, self._extractor.dim)

    def embed(self, pcm: np.ndarray, sample_rate: int) -> np.ndarray:
        if sample_rate != SAMPLE_RATE:
            raise ValueError("speaker embedder expects 16 kHz input")
        if pcm.size < MIN_SEGMENT_SAMPLES:
            pcm = np.pad(pcm, (0, MIN_SEGMENT_SAMPLES - pcm.size))

        audio = pcm.astype(np.float32) / 32768.0
        stream = self._extractor.create_stream()
        stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=audio)
        stream.input_finished()
        emb = np.asarray(self._extractor.compute(stream), dtype=np.float32)
        norm = float(np.linalg.norm(emb))
        return emb if norm == 0 else emb / norm
