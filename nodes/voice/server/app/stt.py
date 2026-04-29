"""faster-whisper STT wrapper (thin sync interface — call from a worker thread)."""
from __future__ import annotations

import logging
import os
import sys
import sysconfig
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)


def _setup_cuda_dlls() -> None:
    """Make pip-installed CUDA libs (nvidia-cudnn-cu12, nvidia-cublas-cu12)
    discoverable by ctranslate2.

    ctranslate2 dlopen()s cuDNN/cuBLAS at runtime; the pip wheels drop them
    into `site-packages/nvidia/<lib>/{bin,lib}/`, which is not on the system
    loader's search path. On Windows we register the dirs via
    `os.add_dll_directory`; on Linux we prepend to LD_LIBRARY_PATH. No-op on
    Mac (no GPU/CUDA support there for ctranslate2 anyway) and on machines
    that haven't installed the nvidia wheels.
    """
    site_packages = sysconfig.get_paths().get("purelib")
    if not site_packages:
        return
    nvidia_root = os.path.join(site_packages, "nvidia")
    if not os.path.isdir(nvidia_root):
        return
    for sub in ("cudnn", "cublas"):
        bin_dir = os.path.join(nvidia_root, sub, "bin")
        lib_dir = os.path.join(nvidia_root, sub, "lib")
        if sys.platform == "win32" and os.path.isdir(bin_dir):
            try:
                os.add_dll_directory(bin_dir)
            except (AttributeError, OSError):
                pass
        elif sys.platform.startswith("linux") and os.path.isdir(lib_dir):
            existing = os.environ.get("LD_LIBRARY_PATH", "")
            if lib_dir not in existing.split(os.pathsep):
                os.environ["LD_LIBRARY_PATH"] = (
                    f"{lib_dir}{os.pathsep}{existing}" if existing else lib_dir
                )


_setup_cuda_dlls()


def _resolve_runtime(device: str, compute_type: str) -> tuple[str, str]:
    """Pick (device, compute_type) for ctranslate2.

    `device="auto"` probes ctranslate2 for a CUDA device; falls back to CPU
    cleanly on machines without a GPU (Mac, headless Linux). MPS is not
    supported by ctranslate2, so Mac always lands on CPU.

    `compute_type="auto"` picks float16 on CUDA (fast, fits in VRAM) and
    int8 on CPU (best CPU throughput).
    """
    if device == "auto":
        try:
            import ctranslate2  # type: ignore[import-not-found]

            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
            else:
                device = "cpu"
        except Exception:
            device = "cpu"
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


class FasterWhisperStt:
    def __init__(
        self,
        model_size: str = "tiny",
        language: str = "fr",
        download_root: Path | None = None,
        compute_type: str = "auto",
        device: str = "auto",
    ) -> None:
        from faster_whisper import WhisperModel  # noqa: WPS433

        resolved_device, resolved_compute = _resolve_runtime(device, compute_type)
        log.info("loading faster-whisper model=%s device=%s compute=%s",
                 model_size, resolved_device, resolved_compute)
        self._model = WhisperModel(
            model_size,
            device=resolved_device,
            compute_type=resolved_compute,
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
