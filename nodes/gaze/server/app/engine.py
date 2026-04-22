"""Gaze pipeline: detect faces → match identity → estimate gaze → describe target.

Gaze direction comes from Gaze-LLE (dedicated gaze-following model); Moondream
stays in the loop only for optional scene description on `describe=true`.
Gaze-LLE gives us:
    - a heatmap (peak = normalized gaze point)
    - an `inout` score (< threshold → gaze target is out-of-frame ≈ looking at
      the camera / viewer)

Identity persistence + event history live in ProfileStore (SQLite).
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from io import BytesIO

import numpy as np
from PIL import Image

from .config import settings
from .gaze import GazeModel
from .gazelle import GazelleModel
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
    looking_at_camera_threshold: float
    looking_at_min_distance: float
    looking_at_stability_frames: int
    inout_threshold: float
    gaze_peak_threshold: float


class GazeEngine:
    def __init__(
        self,
        store: ProfileStore,
        recognizer: Recognizer,
        gazelle: GazelleModel | None,
        moondream: GazeModel | None,
    ) -> None:
        self._store = store
        self._rec = recognizer
        self._gazelle = gazelle
        self._moondream = moondream
        self._tuning = _Tuning(
            match_threshold=settings.match_threshold,
            uncertain_threshold=settings.uncertain_threshold,
            ema_decay=settings.ema_decay,
            looking_at_margin=settings.looking_at_margin,
            looking_at_camera_threshold=settings.looking_at_camera_threshold,
            looking_at_min_distance=settings.looking_at_min_distance,
            looking_at_stability_frames=settings.looking_at_stability_frames,
            inout_threshold=settings.inout_threshold,
            gaze_peak_threshold=settings.gaze_peak_threshold,
        )
        self._last_event: dict[str, tuple[str, str | None, str | None]] = {}
        self._pending: dict[str, tuple[tuple[str, str | None], int]] = {}

    def get_tuning(self) -> dict[str, float]:
        return {
            "match_threshold": self._tuning.match_threshold,
            "uncertain_threshold": self._tuning.uncertain_threshold,
            "ema_decay": self._tuning.ema_decay,
            "looking_at_margin": self._tuning.looking_at_margin,
            "looking_at_camera_threshold": self._tuning.looking_at_camera_threshold,
            "looking_at_min_distance": self._tuning.looking_at_min_distance,
            "looking_at_stability_frames": float(self._tuning.looking_at_stability_frames),
            "inout_threshold": self._tuning.inout_threshold,
            "gaze_peak_threshold": self._tuning.gaze_peak_threshold,
        }

    def set_tuning(self, **updates: float) -> dict[str, float]:
        for key, value in updates.items():
            if hasattr(self._tuning, key) and value is not None:
                if key == "looking_at_stability_frames":
                    setattr(self._tuning, key, max(1, int(value)))
                else:
                    setattr(self._tuning, key, float(value))
        return self.get_tuning()

    def analyze(
        self, image_bytes: bytes, remember: bool = True, describe: bool = False,
    ) -> DetectResponse:
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

        eye_centers: list[tuple[float, float]] = [
            _eye_center_norm(rf, width, height) for rf in raw_faces
        ]

        gaze_points: list[tuple[float, float] | None] = [None] * len(raw_faces)
        inout_scores: list[float | None] = [None] * len(raw_faces)
        peaks: list[float] = [0.0] * len(raw_faces)
        t_gaze = 0.0
        if self._gazelle is not None and raw_faces:
            t0 = time.perf_counter()
            bboxes_norm = [
                _bbox_pixel_to_norm(rf.bbox, width, height) for rf in raw_faces
            ]
            try:
                results = self._gazelle.detect_batch(pil, bboxes_norm)
                for i, r in enumerate(results):
                    # Only keep points with non-trivial peak to avoid emitting
                    # a random hotspot from a flat heatmap.
                    if r.peak > 0.0:
                        gaze_points[i] = (r.gaze_x, r.gaze_y)
                    inout_scores[i] = r.inout
                    peaks[i] = r.peak
            except Exception as e:
                log.warning("gazelle inference failed: %s", e)
            t_gaze = (time.perf_counter() - t0) * 1000

        # Moondream describe (optional, reuses its own image encoding).
        descriptions: list[str | None] = [None] * len(raw_faces)
        t_describe = 0.0
        t_encode = 0.0
        if describe and self._moondream is not None and raw_faces:
            t0 = time.perf_counter()
            encoded = self._moondream.encode_image(pil)
            t_encode = (time.perf_counter() - t0) * 1000
            t0 = time.perf_counter()
            min_dist = self._tuning.looking_at_min_distance
            for i, gp in enumerate(gaze_points):
                if gp is None:
                    continue
                dist = math.hypot(gp[0] - eye_centers[i][0], gp[1] - eye_centers[i][1])
                if dist < min_dist:
                    continue
                # Skip if gaze is out-of-frame (inout low) — describing a
                # pixel outside the reported target is meaningless.
                if inout_scores[i] is not None and inout_scores[i] < self._tuning.inout_threshold:
                    continue
                descriptions[i] = self._moondream.describe_at(encoded, gp)
            t_describe = (time.perf_counter() - t0) * 1000

        faces_out: list[DetectedFace] = []
        for i, ((rf, profile_id, name, color, conf, provisional), gp, eye_xy, desc) in enumerate(
            zip(identified, gaze_points, eye_centers, descriptions, strict=True)
        ):
            bbox_norm = _bbox_pixel_to_norm(rf.bbox, width, height)
            peak_conf = peaks[i]
            # Zero out low-confidence peaks: Gazelle is basically guessing.
            if peak_conf < self._tuning.gaze_peak_threshold:
                gp = None
            gaze_point = GazePoint(x=gp[0], y=gp[1]) if gp else None
            eye = GazePoint(x=eye_xy[0], y=eye_xy[1])
            inout = inout_scores[i]
            # "Looking at camera" strategy:
            #   - peak confident → trust Gazelle, the target is in-frame
            #   - peak low + face frontal → probably camera
            #   - peak low + face turned away → unresolved (emit nothing)
            if gp is not None:
                looking_at_camera = False
            else:
                looking_at_camera = _is_face_frontal(rf)

            faces_out.append(DetectedFace(
                face_index=i,
                profile_id=profile_id,
                name=name,
                color=color,
                bbox=Bbox(
                    x_min=bbox_norm[0], y_min=bbox_norm[1],
                    x_max=bbox_norm[2], y_max=bbox_norm[3],
                ),
                eye_center=eye,
                gaze=gaze_point,
                inout_score=inout,
                gaze_peak=peaks[i] if peaks[i] > 0.0 else None,
                looking_at=None,
                looking_at_camera=looking_at_camera,
                looking_at_description=desc,
                match_confidence=conf,
                provisional=provisional,
            ))

        _resolve_looking_at(
            faces_out,
            self._tuning.looking_at_margin,
            self._tuning.looking_at_min_distance,
            eye_centers,
        )

        self._apply_stability(faces_out)
        self._record_events(faces_out)

        total_ms = t_detect + t_match + t_encode + t_gaze + t_describe
        log.info(
            "analyzed %d face(s) in %.0fms (detect=%.0f match=%.0f gaze=%.0f encode=%.0f describe=%.0f) "
            "inout=%s peaks=%s cam=%d",
            len(raw_faces), total_ms, t_detect, t_match, t_gaze, t_encode, t_describe,
            [f"{v:.2f}" if v is not None else "-" for v in inout_scores],
            [f"{p:.3f}" for p in peaks],
            sum(1 for f in faces_out if f.looking_at_camera),
        )

        return DetectResponse(
            width=width,
            height=height,
            faces=faces_out,
            elapsed_ms={
                "detect": round(t_detect, 1),
                "match": round(t_match, 1),
                "encode": round(t_encode, 1),
                "gaze": round(t_gaze, 1),
                "describe": round(t_describe, 1),
            },
        )

    def _apply_stability(self, faces: list[DetectedFace]) -> None:
        needed = self._tuning.looking_at_stability_frames
        if needed <= 1:
            return
        for f in faces:
            if not f.profile_id:
                continue
            if f.looking_at_camera:
                key: tuple[str, str | None] = ("camera", None)
            elif f.looking_at:
                key = ("profile", f.looking_at)
            else:
                self._pending.pop(f.profile_id, None)
                continue

            prev = self._pending.get(f.profile_id)
            streak = prev[1] + 1 if (prev is not None and prev[0] == key) else 1
            self._pending[f.profile_id] = (key, streak)

            if streak < needed:
                f.looking_at = None
                f.looking_at_camera = False

    def _record_events(self, faces: list[DetectedFace]) -> None:
        for f in faces:
            if not f.profile_id:
                continue
            target_type: str
            target_profile: str | None = None
            description: str | None = None
            gaze_xy: tuple[float, float] | None = None
            if f.looking_at_camera:
                target_type = "camera"
            elif f.looking_at and f.looking_at.startswith("face_"):
                target_profile = _resolve_target_profile(f.looking_at, faces)
                if target_profile is None:
                    continue
                target_type = "profile"
            elif f.gaze is not None and f.looking_at_description:
                target_type = "scene"
                description = f.looking_at_description
                gaze_xy = (f.gaze.x, f.gaze.y)
            else:
                continue

            sig = (target_type, target_profile, description)
            if self._last_event.get(f.profile_id) == sig:
                continue
            self._last_event[f.profile_id] = sig
            self._store.record_event(
                source_profile_id=f.profile_id,
                target_type=target_type,
                target_profile_id=target_profile,
                description=description,
                gaze_xy=gaze_xy,
            )

    def _resolve_identity(
        self, face: RawFace, remember: bool,
    ) -> tuple[str | None, str | None, str | None, float, bool]:
        emb = face.embedding
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
            return (profile["id"], profile["name"], profile["color"], best_sim, True)

        if not remember:
            return (None, None, None, best_sim, True)
        profile = self._store.create(centroid=emb)
        log.info("identity: NEW %s (best_sim=%.3f < uncertain=%.2f)",
                 profile["id"], best_sim, uncertain_t)
        return (profile["id"], profile["name"], profile["color"], 1.0, False)


def _pil_to_bgr(pil: "Image.Image") -> np.ndarray:
    arr = np.asarray(pil)
    return arr[:, :, ::-1].copy()


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


def _is_face_frontal(face: RawFace, asym_threshold: float = 0.22) -> bool:
    """Heuristic: head roughly facing the camera.

    Horizontal asymmetry between nose↔left_eye vs nose↔right_eye distances
    collapses as the head turns. Same check on mouth corners filters out
    tilted but frontal heads. Used as a secondary "looking at camera" signal
    when Gazelle has no confident gaze target (peak below threshold).
    """
    left_eye, right_eye, nose, left_mouth, right_mouth = face.landmarks
    dx_l_eye = abs(float(nose[0]) - float(left_eye[0]))
    dx_r_eye = abs(float(nose[0]) - float(right_eye[0]))
    eye_span = dx_l_eye + dx_r_eye
    if eye_span < 1e-6:
        return False
    eye_asym = abs(dx_l_eye - dx_r_eye) / eye_span
    dx_l_mouth = abs(float(nose[0]) - float(left_mouth[0]))
    dx_r_mouth = abs(float(nose[0]) - float(right_mouth[0]))
    mouth_span = dx_l_mouth + dx_r_mouth
    mouth_asym = (
        abs(dx_l_mouth - dx_r_mouth) / mouth_span if mouth_span > 1e-6 else 1.0
    )
    return eye_asym < asym_threshold and mouth_asym < asym_threshold


def _eye_center_norm(face: RawFace, width: int, height: int) -> tuple[float, float]:
    left = face.landmarks[0]
    right = face.landmarks[1]
    cx = (float(left[0]) + float(right[0])) / 2.0
    cy = (float(left[1]) + float(right[1])) / 2.0
    return (
        max(0.0, min(1.0, cx / width)),
        max(0.0, min(1.0, cy / height)),
    )


def _ema_update(prev: np.ndarray | None, new: np.ndarray, decay: float) -> np.ndarray:
    if prev is None:
        return new
    merged = (1.0 - decay) * prev + decay * new
    return _l2_normalize(merged)


def _l2_normalize(v: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(v))
    return v if norm == 0 else (v / norm).astype(np.float32)


def _resolve_target_profile(marker: str, faces: list[DetectedFace]) -> str | None:
    if marker.startswith("face_"):
        for f in faces:
            if f.profile_id == marker:
                return marker
        parts = marker.split("_", 1)
        if len(parts) == 2 and parts[1].isdigit():
            idx = int(parts[1])
            for f in faces:
                if f.face_index == idx and f.profile_id:
                    return f.profile_id
    return None


def _resolve_looking_at(
    faces: list[DetectedFace],
    margin: float,
    min_distance: float,
    eye_centers: list[tuple[float, float]],
) -> None:
    for idx, src in enumerate(faces):
        if src.gaze is None or src.looking_at_camera:
            continue
        gx, gy = src.gaze.x, src.gaze.y
        eye_x, eye_y = eye_centers[idx]
        if math.hypot(gx - eye_x, gy - eye_y) < min_distance:
            continue
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
                if area < best_area:
                    best_area = area
                    best_id = tgt.profile_id or f"face_{tgt.face_index}"
                    best_face_index = tgt.face_index
        if best_face_index is not None:
            src.looking_at = best_id
