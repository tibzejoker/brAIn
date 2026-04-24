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
from .iris import IrisTracker
from .models import Bbox, DetectedFace, DetectResponse, GazePoint
from .profiles import ProfileStore, _now as _now_iso
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
    min_face_fraction: float
    camera_asym_threshold: float
    camera_yaw_threshold: float
    iris_to_head_scale: float
    event_heartbeat_s: float


class GazeEngine:
    def __init__(
        self,
        store: ProfileStore,
        recognizer: Recognizer,
        gazelle: GazelleModel | None,
        moondream: GazeModel | None,
        iris: IrisTracker | None,
    ) -> None:
        self._store = store
        self._rec = recognizer
        self._gazelle = gazelle
        self._moondream = moondream
        self._iris = iris
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
            min_face_fraction=settings.min_face_fraction,
            camera_asym_threshold=settings.camera_asym_threshold,
            camera_yaw_threshold=settings.camera_yaw_threshold,
            iris_to_head_scale=settings.iris_to_head_scale,
            event_heartbeat_s=settings.event_heartbeat_s,
        )
        self._last_event: dict[str, tuple[str, str | None, str | None]] = {}
        # Wall-clock (epoch seconds) of the last event we wrote for each
        # source profile. We re-emit the current state as a "heartbeat"
        # after `event_heartbeat_s` so downstream consumers (intent
        # correlator) can always see a recent gaze timestamp, even when
        # the subject holds the same state for a long time.
        self._last_event_ts: dict[str, float] = {}
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
            "min_face_fraction": self._tuning.min_face_fraction,
            "camera_asym_threshold": self._tuning.camera_asym_threshold,
            "camera_yaw_threshold": self._tuning.camera_yaw_threshold,
            "iris_to_head_scale": self._tuning.iris_to_head_scale,
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
        # Capture the frame's arrival wall-clock up front. Any event that
        # comes out of this call will be stamped with this time so the
        # downstream correlator sees the moment the subject's gaze was
        # actually in that state — not the moment after Moondream /
        # other slow per-frame inference finished.
        frame_ts = _now_iso()
        pil = Image.open(BytesIO(image_bytes)).convert("RGB")
        width, height = pil.size

        t0 = time.perf_counter()
        image_bgr = _pil_to_bgr(pil)
        raw_faces = self._rec.detect(image_bgr)
        min_side = min(width, height) * self._tuning.min_face_fraction
        if min_side > 0:
            raw_faces = [
                rf for rf in raw_faces
                if min(rf.bbox[2] - rf.bbox[0], rf.bbox[3] - rf.bbox[1]) >= min_side
            ]
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
        iris_pairs: list[tuple[float, float] | None] = [None] * len(raw_faces)
        t_gaze = 0.0
        t_iris = 0.0

        if self._iris is not None and raw_faces:
            t0 = time.perf_counter()
            image_rgb = np.asarray(pil)
            for i, rf in enumerate(raw_faces):
                bbox_norm = _bbox_pixel_to_norm(rf.bbox, width, height)
                try:
                    res = self._iris.measure(image_rgb, bbox_norm)
                except Exception as e:  # noqa: BLE001
                    log.warning("iris measurement failed for face %d: %s", i, e)
                    continue
                if res is not None:
                    iris_pairs[i] = (res.yaw_left, res.yaw_right)
            t_iris = (time.perf_counter() - t0) * 1000
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

            # "Looking at camera" via combined head + iris signal.
            #
            # world_yaw = head_yaw + iris_compensation, per eye. If the
            # head is turned BUT the eyes counter-rotate (shift toward the
            # opposite side in head frame), the effective gaze in world
            # frame can still land on the lens. We pick the eye with the
            # smallest |world_yaw| — a person reliably fixating the camera
            # with ONE eye (e.g. Disaster Girl compensating a left turn
            # with her right eye) still registers as eye contact.
            #
            # When iris tracking fails (MediaPipe couldn't fit on a heavy
            # profile crop), we fall back to head-only: require head near-
            # frontal. Profile faces fail that too, so this stays strict.
            head_y = _head_yaw_signed(rf)
            pair = iris_pairs[i]
            scale = self._tuning.iris_to_head_scale
            world_yaw: float | None
            if pair is not None:
                iris_l, iris_r = pair
                # Camera-left eye's "iris toward inner" = toward image-right.
                # head_y > 0 also means nose toward image-right. Add directly.
                # Camera-right eye's "iris toward inner" = toward image-left.
                # Flip sign so both converge toward the same world frame.
                world_l = head_y + iris_l * scale
                world_r = head_y - iris_r * scale
                world_yaw = world_l if abs(world_l) < abs(world_r) else world_r
                looking_at_camera = abs(world_yaw) < self._tuning.camera_yaw_threshold
            else:
                # Fallback — head-only. `_is_face_frontal` uses the same
                # half-eye-distance metric so `camera_asym_threshold` is the
                # right knob here.
                world_yaw = None
                looking_at_camera = abs(head_y) < self._tuning.camera_asym_threshold

            if looking_at_camera:
                gp = None
            gaze_point = GazePoint(x=gp[0], y=gp[1]) if gp else None
            eye = GazePoint(x=eye_xy[0], y=eye_xy[1])
            inout = inout_scores[i]

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
                iris_yaw=world_yaw,
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
        self._record_events(faces_out, frame_ts)

        total_ms = t_detect + t_match + t_encode + t_gaze + t_describe + t_iris
        head_yaws = [_head_yaw_signed(rf) for rf in raw_faces]
        iris_strs = [
            f"{p[0]:+.2f}/{p[1]:+.2f}" if p is not None else "-"
            for p in iris_pairs
        ]
        log.info(
            "analyzed %d face(s) in %.0fms (detect=%.0f match=%.0f gaze=%.0f iris=%.0f encode=%.0f describe=%.0f) "
            "peaks=%s head=%s iris=%s cam=%d",
            len(raw_faces), total_ms, t_detect, t_match, t_gaze, t_iris, t_encode, t_describe,
            [f"{p:.2f}" for p in peaks],
            [f"{y:+.2f}" for y in head_yaws],
            iris_strs,
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
                "iris": round(t_iris, 1),
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

    def _record_events(self, faces: list[DetectedFace], frame_ts: str) -> None:
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
            now_ts = time.time()
            last_sig = self._last_event.get(f.profile_id)
            last_ts = self._last_event_ts.get(f.profile_id, 0.0)
            state_changed = last_sig != sig
            heartbeat_due = (
                not state_changed and (now_ts - last_ts) >= self._tuning.event_heartbeat_s
            )
            if not state_changed and not heartbeat_due:
                continue
            self._last_event[f.profile_id] = sig
            self._last_event_ts[f.profile_id] = now_ts
            self._store.record_event(
                source_profile_id=f.profile_id,
                target_type=target_type,
                target_profile_id=target_profile,
                description=description,
                gaze_xy=gaze_xy,
                ts=frame_ts,
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


def _head_yaw_signed(face: RawFace) -> float:
    """Signed head-yaw from InsightFace landmarks, in half-eye-distance units.

    Projects (nose − eye_midpoint) onto the eye-axis direction (left→right
    eye), normalized by half the eye distance. Invariant to head roll
    because it measures along-axis displacement only. Sign convention:
    positive = head turned to subject's left (nose drifts toward camera-
    right in image); negative = head turned to subject's right.

    Magnitudes: ≈ 0 frontal, ≈ 0.5 at 3/4-view, ≈ 1.0 near profile.
    """
    left_eye, right_eye, nose, _lm, _rm = face.landmarks
    lx, ly = float(left_eye[0]), float(left_eye[1])
    rx, ry = float(right_eye[0]), float(right_eye[1])
    ex_axis, ey_axis = rx - lx, ry - ly
    eye_len = math.hypot(ex_axis, ey_axis)
    if eye_len < 1e-6:
        return 0.0
    ux, uy = ex_axis / eye_len, ey_axis / eye_len
    mx, my = (lx + rx) / 2, (ly + ry) / 2
    nose_lat = (float(nose[0]) - mx) * ux + (float(nose[1]) - my) * uy
    return nose_lat / (eye_len / 2)


def _frontality_asym(face: RawFace) -> float:
    """Head-turn magnitude (|head_yaw|) — used for profile-face fallback
    when iris tracking isn't available.
    """
    return abs(_head_yaw_signed(face))


def _is_face_frontal(face: RawFace, asym_threshold: float = 0.22) -> bool:
    """Heuristic: head roughly facing the camera (worst-of eye/mouth asym)."""
    return _frontality_asym(face) < asym_threshold


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
