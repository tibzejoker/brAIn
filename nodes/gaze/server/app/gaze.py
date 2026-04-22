"""Moondream 2 wrapper — gaze direction + optional gaze-target description.

The 2025-01-09 revision's `encode_image` returns an `EncodedImage` that can be
reused across `_detect_gaze` and `query` calls; this lets us pay the encoding
cost once per frame instead of per face, which dominates latency on MPS.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


def _resolve_device(choice: str) -> str:
    if choice != "auto":
        return choice
    try:
        import torch  # type: ignore[import-not-found]

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


class GazeModel:
    def __init__(
        self,
        repo: str,
        revision: str,
        cache_dir: Path,
        device: str = "auto",
    ) -> None:
        import torch  # type: ignore[import-not-found]
        from transformers import AutoModelForCausalLM  # type: ignore[import-not-found]

        cache_dir.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(cache_dir))

        resolved_device = _resolve_device(device)
        dtype = torch.float16 if resolved_device in ("mps", "cuda") else torch.float32
        log.info("loading moondream %s@%s on %s (%s)", repo, revision, resolved_device, dtype)

        model = AutoModelForCausalLM.from_pretrained(
            repo,
            revision=revision,
            trust_remote_code=True,
            torch_dtype=dtype,
            cache_dir=str(cache_dir),
        )
        model = model.to(resolved_device)
        model.eval()
        self._model = model
        # HfMoondream wraps the real model in `.model`; `_detect_gaze` lives
        # on the inner MoondreamModel and isn't proxied.
        self._inner = getattr(model, "model", model)
        self._device = resolved_device
        log.info("moondream ready on %s", resolved_device)

    def encode_image(self, image: Any) -> Any:
        """Return an EncodedImage reusable across detect_gaze / query calls."""
        import torch  # type: ignore[import-not-found]

        with torch.inference_mode():
            return self._model.encode_image(image)

    def detect_gaze(
        self,
        encoded_image: Any,
        eye_xy: tuple[float, float],
        force_detect: bool = False,
    ) -> tuple[float, float] | None:
        import torch  # type: ignore[import-not-found]

        try:
            with torch.inference_mode():
                raw = self._inner._detect_gaze(
                    encoded_image, (float(eye_xy[0]), float(eye_xy[1])),
                    force_detect=force_detect,
                )
        except Exception as e:
            log.warning("_detect_gaze failed: %s", e)
            return None

        gaze = _extract_gaze(raw)
        if gaze is None:
            return None
        gx = max(0.0, min(1.0, gaze[0]))
        gy = max(0.0, min(1.0, gaze[1]))
        return (gx, gy)

    def describe_at(
        self,
        encoded_image: Any,
        gaze_point: tuple[float, float],
    ) -> str | None:
        """Short natural-language description of what sits at the gaze point."""
        import torch  # type: ignore[import-not-found]

        prompt = (
            "In a few words, describe what is at coordinate "
            f"({gaze_point[0]:.2f}, {gaze_point[1]:.2f}) "
            "of the image. Be concrete and concise (3-6 words)."
        )
        try:
            with torch.inference_mode():
                result = self._model.query(encoded_image, prompt)
        except Exception as e:
            log.warning("moondream.query failed: %s", e)
            return None

        answer = _extract_answer(result)
        if not answer:
            return None
        # Collapse whitespace and trim trailing punctuation.
        return " ".join(answer.strip().split()).rstrip(".!?,")


def _extract_gaze(raw: Any) -> tuple[float, float] | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        node = raw.get("gaze", raw)
        if node is None:
            return None
        if isinstance(node, dict):
            x = node.get("x")
            y = node.get("y")
            if x is not None and y is not None:
                return (float(x), float(y))
        if isinstance(node, (list, tuple)) and len(node) >= 2:
            return (float(node[0]), float(node[1]))
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        return (float(raw[0]), float(raw[1]))
    return None


def _extract_answer(raw: Any) -> str | None:
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw
    if isinstance(raw, dict):
        for key in ("answer", "response", "text"):
            value = raw.get(key)
            if isinstance(value, str):
                return value
    return None
