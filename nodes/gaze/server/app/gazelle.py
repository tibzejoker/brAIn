"""Gaze-LLE wrapper: specialized gaze-target model (heatmap + in/out score).

Compared to Moondream's VLM-based gaze, Gaze-LLE is a dedicated gaze-following
model built on a frozen DINOv2 backbone + a light decoder. It returns:
    - a 64×64 spatial heatmap of likely gaze locations
    - an "inout" score (0..1) giving the probability the gaze target is in-frame

The inout score is the clean signal we need to distinguish "looking in the
scene" from "looking at camera / out of frame".
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
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


@dataclass(slots=True)
class GazelleResult:
    # Normalized heatmap peak (argmax) — our best guess for the target point.
    gaze_x: float
    gaze_y: float
    # Peak confidence in [0, 1].
    peak: float
    # Probability gaze target is in-frame (1.0 = in-frame, 0.0 = out/camera).
    inout: float | None


class GazelleModel:
    def __init__(self, variant: str, device: str = "auto") -> None:
        import torch  # type: ignore[import-not-found]

        resolved_device = _resolve_device(device)
        log.info("loading gazelle variant=%s device=%s", variant, resolved_device)
        model, transform = torch.hub.load(
            "fkryan/gazelle", variant, trust_repo=True,
        )
        model = model.to(resolved_device).eval()
        self._model = model
        self._transform = transform
        self._device = resolved_device
        self._has_inout = "_inout" in variant
        log.info("gazelle ready on %s", resolved_device)

    def detect_batch(
        self,
        image: Any,  # PIL.Image.Image
        bboxes_norm: list[tuple[float, float, float, float]],
    ) -> list[GazelleResult]:
        """One forward pass for all faces in an image.

        Returns one `GazelleResult` per input bbox, in order.
        """
        if not bboxes_norm:
            return []

        import torch  # type: ignore[import-not-found]

        img_tensor = self._transform(image).unsqueeze(0).to(self._device)
        model_input = {
            "images": img_tensor,
            "bboxes": [bboxes_norm],
        }

        with torch.inference_mode():
            out = self._model(model_input)

        heatmaps = out["heatmap"][0]
        inouts_raw = out.get("inout") if self._has_inout else None
        inouts = inouts_raw[0] if inouts_raw is not None else [None] * len(bboxes_norm)

        results: list[GazelleResult] = []
        for idx in range(len(bboxes_norm)):
            hm = heatmaps[idx]
            h, w = int(hm.shape[-2]), int(hm.shape[-1])
            flat_idx = int(hm.reshape(-1).argmax().item())
            gy, gx = divmod(flat_idx, w)
            peak = float(hm.max().item())
            gx_norm = (gx + 0.5) / w
            gy_norm = (gy + 0.5) / h
            inout: float | None = None
            if self._has_inout:
                io_val = inouts[idx]
                # The model emits a logit — sigmoid to get a [0,1] probability.
                if hasattr(io_val, "item"):
                    inout = float(torch.sigmoid(io_val).item())
                else:
                    inout = 1.0 / (1.0 + math.exp(-float(io_val)))
            results.append(GazelleResult(
                gaze_x=gx_norm, gaze_y=gy_norm, peak=peak, inout=inout,
            ))
        return results
