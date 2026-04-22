"""InsightFace wrapper: detection + 512d recognition embedding in one pass.

buffalo_l (default) = SCRFD-10G detector + ArcFace R100 embedder. The resulting
embedding is already L2-normalized so cosine similarity is a plain dot product.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)


@dataclass(slots=True)
class DetectedFace:
    index: int
    bbox: tuple[int, int, int, int]  # x1, y1, x2, y2 in pixel coords
    # 5 landmarks from SCRFD: left_eye, right_eye, nose, left_mouth, right_mouth
    # in pixel coordinates.
    landmarks: np.ndarray  # shape (5, 2), dtype float32
    embedding: np.ndarray  # 512d, L2-normalized
    det_score: float


class Recognizer:
    def __init__(self, model_name: str, det_size: int, root: str | None = None) -> None:
        from insightface.app import FaceAnalysis

        kwargs: dict[str, object] = {
            "name": model_name,
            "allowed_modules": ["detection", "recognition"],
        }
        if root is not None:
            kwargs["root"] = root
        self._app = FaceAnalysis(**kwargs)
        # ctx_id=-1 forces CPU. InsightFace's ORT providers pick MPS-less CPU by
        # default on Mac — no CoreML pain to deal with.
        self._app.prepare(ctx_id=-1, det_size=(det_size, det_size))
        log.info("recognizer ready (model=%s det_size=%d)", model_name, det_size)

    def detect(self, image_bgr: np.ndarray) -> list[DetectedFace]:
        faces = self._app.get(image_bgr)
        result: list[DetectedFace] = []
        for i, f in enumerate(faces):
            x1, y1, x2, y2 = (int(v) for v in f.bbox)
            emb = f.normed_embedding.astype(np.float32)
            kps = np.asarray(f.kps, dtype=np.float32)  # (5, 2) pixel coords
            result.append(DetectedFace(
                index=i,
                bbox=(x1, y1, x2, y2),
                landmarks=kps,
                embedding=emb,
                det_score=float(f.det_score),
            ))
        return result
