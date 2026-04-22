"""Moondream 2 wrapper for per-face gaze direction.

Uses the HuggingFace revision 2025-01-09 which first shipped `detect_gaze`.
Given a PIL image + a face bbox (normalized 0-1), returns a normalized (x,y)
gaze point in image coordinates, or None if Moondream can't determine a target.
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
        self._device = resolved_device
        log.info("moondream ready on %s", resolved_device)

    def detect_gaze(
        self,
        image: Any,  # PIL.Image.Image
        face_bbox_norm: tuple[float, float, float, float],
        accurate: bool = False,
    ) -> tuple[float, float] | None:
        """Return a normalized gaze point, or None.

        `accurate=True` uses Moondream's multi-sample averaging path (20 forward
        passes, slower but more robust); the default fast path does a single
        inference at a synthesized eye position derived from the face bbox
        (eyes sit at ~35% of face height from the top).
        """
        x_min, y_min, x_max, y_max = face_bbox_norm
        face_arg = {
            "x_min": float(x_min),
            "y_min": float(y_min),
            "x_max": float(x_max),
            "y_max": float(y_max),
        }
        eye_xy = (
            (x_min + x_max) / 2.0,
            y_min + 0.35 * (y_max - y_min),
        )
        try:
            import torch  # type: ignore[import-not-found]

            with torch.inference_mode():
                if accurate:
                    result = self._model.detect_gaze(
                        image, face=face_arg,
                        unstable_settings={
                            "prioritize_accuracy": True,
                            "force_detect": True,
                        },
                    )
                else:
                    # force_detect=True bypasses Moondream's internal EOS short-circuit
                    # so we always get a direction even when the target isn't clearly
                    # in frame (useful as a visual indicator for "approximate gaze").
                    result = self._model.detect_gaze(
                        image, eye=eye_xy,
                        unstable_settings={"force_detect": True},
                    )
        except Exception as e:
            log.warning("moondream.detect_gaze failed: %s", e)
            return None

        gaze = _extract_gaze(result)
        if gaze is None:
            log.debug("moondream returned no gaze for face %s", face_arg)
            return None
        gx = max(0.0, min(1.0, gaze[0]))
        gy = max(0.0, min(1.0, gaze[1]))
        return (gx, gy)


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
