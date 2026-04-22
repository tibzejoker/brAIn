"""Gaze pipeline: detect faces → match identity → estimate gaze → resolve 'looking_at'.

Single entry point `GazeEngine.analyze(image)` returns a structured response
covering every detected face, their identity (new or matched profile), gaze
direction, and which other face each is looking at (if any).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from io import BytesIO

import numpy as np
from PIL import Image

from .config import settings
from .gaze import GazeModel
from .models import Bbox, DetectedFace, DetectResponse, GazePoint
from .profiles import ProfileStore
from .recognizer import DetectedFace as RawFace
from .recognizer import Recognizer

log = logging.getLogger(__name__)


@dataclass(slots=True)
class _Tuning:
    match_threshold: float
    uncertain_threshold: float
    ema_decay: float
    looking_at_margin: float


class GazeEngine:
    def __init__(
        self,
        store: ProfileStore,
        recognizer: Recognizer,
        gaze_model: GazeModel | None,
    ) -> None:
        self._store = store
        self._rec = recognizer
        self._gaze = gaze_model
        self._tuning = _Tuning(
            match_threshold=settings.match_threshold,
            uncertain_threshold=settings.uncertain_threshold,
            ema_decay=settings.ema_decay,
            looking_at_margin=settings.looking_at_margin,
        )

    def get_tuning(self) -> dict[str, float]:
        return {
            "match_threshold": self._tuning.match_threshold,
            "uncertain_threshold": self._tuning.uncertain_threshold,
            "ema_decay": self._tuning.ema_decay,
            "looking_at_margin": self._tuning.looking_at_margin,
        }

    def set_tuning(self, **updates: float) -> dict[str, float]:
        for key, value in updates.items():
            if hasattr(self._tuning, key) and value is not None:
                setattr(self._tuning, key, float(value))
        return self.get_tuning()

    def analyze(self, image_bytes: bytes, remember: bool = True) -> DetectResponse:
        pil = Image.open(BytesIO(image_bytes)).convert("RGB")
        width, height = pil.size

        t0 = time.perf_counter()
        image_bgr = _pil_to_bgr(pil)
        raw_faces = self._rec.detect(image_bgr)
        t_detect = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        identified: list[tuple[RawFace, str | None, str | None, str | None, float, bool]] = []
        for rf in raw_faces:
            profile_id, name, color, conf, provisional = self._resolve_identity(rf, remember)
            identified.append((rf, profile_id, name, color, conf, provisional))
        t_match = (time.perf_counter() - t0) * 1000

        t0 = time.perf_counter()
        gaze_points: list[tuple[float, float] | None] = []
        if self._gaze is not None:
            for rf in raw_faces:
                bbox_norm = _bbox_pixel_to_norm(rf.bbox, width, height)
                gaze_points.append(
                    self._gaze.detect_gaze(pil, bbox_norm, accurate=settings.gaze_accurate),
                )
        else:
            gaze_points = [None] * len(raw_faces)
        t_gaze = (time.perf_counter() - t0) * 1000
        log.info(
            "analyzed %d face(s) in %.0fms (detect=%.0f match=%.0f gaze=%.0f) gaze_hits=%d",
            len(raw_faces), t_detect + t_match + t_gaze, t_detect, t_match, t_gaze,
            sum(1 for g in gaze_points if g is not None),
        )

        faces_out: list[DetectedFace] = []
        for i, ((rf, profile_id, name, color, conf, provisional), gp) in enumerate(
            zip(identified, gaze_points, strict=True)
        ):
            bbox_norm = _bbox_pixel_to_norm(rf.bbox, width, height)
            gaze_point = GazePoint(x=gp[0], y=gp[1]) if gp else None
            faces_out.append(DetectedFace(
                face_index=i,
                profile_id=profile_id,
                name=name,
                color=color,
                bbox=Bbox(
                    x_min=bbox_norm[0], y_min=bbox_norm[1],
                    x_max=bbox_norm[2], y_max=bbox_norm[3],
                ),
                gaze=gaze_point,
                looking_at=None,
                match_confidence=conf,
                provisional=provisional,
            ))

        _resolve_looking_at(faces_out, self._tuning.looking_at_margin)

        return DetectResponse(
            width=width,
            height=height,
            faces=faces_out,
            elapsed_ms={
                "detect": round(t_detect, 1),
                "match": round(t_match, 1),
                "gaze": round(t_gaze, 1),
            },
        )

    def _resolve_identity(
        self, face: RawFace, remember: bool,
    ) -> tuple[str | None, str | None, str | None, float, bool]:
        emb = face.embedding  # already L2-normalized by InsightFace
        faceprints = self._store.all_faceprints()

        if not faceprints:
            if not remember:
                return (None, None, None, 0.0, True)
            profile = self._store.create(centroid=emb)
            log.info("identity: first profile %s", profile["id"])
            return (profile["id"], profile["name"], profile["color"], 1.0, False)

        best_fp_id, best_pid, best_sim = "", "", -1.0
        for fp_id, pid, centroid in faceprints:
            sim = float(np.dot(emb, centroid))
            if sim > best_sim:
                best_fp_id, best_pid, best_sim = fp_id, pid, sim

        match_t = self._tuning.match_threshold
        uncertain_t = self._tuning.uncertain_threshold

        if best_sim >= match_t:
            if remember:
                prev = self._store.faceprints_for(best_pid)
                prev_centroid = next((c for fid, c in prev if fid == best_fp_id), None)
                updated = _ema_update(prev_centroid, emb, self._tuning.ema_decay)
                self._store.update_faceprint(best_fp_id, updated)
                self._store.bump_sample(best_pid)
            profile = self._store.get(best_pid)
            assert profile is not None
            return (profile["id"], profile["name"], profile["color"], best_sim, False)

        if best_sim >= uncertain_t:
            profile = self._store.get(best_pid)
            assert profile is not None
            # Uncertain zone: do NOT update the centroid (avoid drift) but return
            # the likely profile with provisional=true so the UI can flag it.
            return (profile["id"], profile["name"], profile["color"], best_sim, True)

        if not remember:
            return (None, None, None, best_sim, True)
        profile = self._store.create(centroid=emb)
        log.info("identity: NEW %s (best_sim=%.3f < uncertain=%.2f)",
                 profile["id"], best_sim, uncertain_t)
        return (profile["id"], profile["name"], profile["color"], 1.0, False)


def _pil_to_bgr(pil: "Image.Image") -> np.ndarray:
    arr = np.asarray(pil)  # RGB
    return arr[:, :, ::-1].copy()  # BGR for InsightFace/OpenCV


def _bbox_pixel_to_norm(
    bbox: tuple[int, int, int, int], width: int, height: int,
) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = bbox
    return (
        max(0.0, min(1.0, x1 / width)),
        max(0.0, min(1.0, y1 / height)),
        max(0.0, min(1.0, x2 / width)),
        max(0.0, min(1.0, y2 / height)),
    )


def _ema_update(prev: np.ndarray | None, new: np.ndarray, decay: float) -> np.ndarray:
    if prev is None:
        return new
    merged = (1.0 - decay) * prev + decay * new
    return _l2_normalize(merged)


def _l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(v))
    return v if norm == 0 else (v / norm).astype(np.float32)


def _resolve_looking_at(faces: list[DetectedFace], margin: float) -> None:
    """For each face with a gaze point, find whose (inflated) bbox contains it."""
    for src in faces:
        if src.gaze is None:
            continue
        gx, gy = src.gaze.x, src.gaze.y
        best_id: str | None = None
        best_face_index: int | None = None
        best_area = float("inf")
        for tgt in faces:
            if tgt.face_index == src.face_index:
                continue
            x1 = max(0.0, tgt.bbox.x_min - margin)
            y1 = max(0.0, tgt.bbox.y_min - margin)
            x2 = min(1.0, tgt.bbox.x_max + margin)
            y2 = min(1.0, tgt.bbox.y_max + margin)
            if x1 <= gx <= x2 and y1 <= gy <= y2:
                area = (x2 - x1) * (y2 - y1)
                # Prefer the tightest containing bbox — disambiguates when
                # the gaze point falls into overlapping inflated regions.
                if area < best_area:
                    best_area = area
                    best_id = tgt.profile_id or f"face_{tgt.face_index}"
                    best_face_index = tgt.face_index
        if best_face_index is not None:
            src.looking_at = best_id
