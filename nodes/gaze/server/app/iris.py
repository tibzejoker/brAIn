"""MediaPipe FaceLandmarker iris tracker.

Given a single-face crop, returns the horizontal iris offset (yaw) for each
eye, normalized by eye width. 0 = iris centered between eye corners (looking
straight ahead within the head's frame); ±0.5 = iris at the corner.

The `yaw` signal tells us where the eye is looking **relative to the head**.
Paired with the head-frontality signal from InsightFace landmarks (engine's
`_is_face_frontal`), we get a strict "looking at camera" verdict: head must
be frontal AND iris must be centered before we commit.

FaceLandmarker is tuned for selfie / single-face scenes — passing a crop per
InsightFace bbox avoids the group-photo failure mode where it only picks
one face out of many.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

# MediaPipe FaceMesh indices (camera-side, not subject-side).
_CAM_LEFT_EYE_OUTER = 33
_CAM_LEFT_EYE_INNER = 133
_CAM_LEFT_IRIS = (469, 470, 471, 472)
_CAM_RIGHT_EYE_OUTER = 263
_CAM_RIGHT_EYE_INNER = 362
_CAM_RIGHT_IRIS = (474, 475, 476, 477)


@dataclass(slots=True)
class IrisResult:
    """Axis-projected iris offset per eye, signed in head frame.

    Each yaw is `t - 0.5` where t is the iris center's position along the
    eye's outer→inner axis (t=0 at outer corner, t=1 at inner corner).
    Same-sign conventions don't match between the two eyes: because the
    "inner corner" for the camera-left eye is on the camera-right side of
    the eye but the "inner corner" for the camera-right eye is on the
    camera-left side, a lateral gaze shifts the two yaws in opposite
    directions. World-frame combination in the engine handles this.
    """
    yaw_left: float   # camera-left eye (subject's right eye)
    yaw_right: float  # camera-right eye (subject's left eye)


class IrisTracker:
    def __init__(self, task_path: Path) -> None:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        if not task_path.exists():
            raise FileNotFoundError(f"{task_path} — run `python -m app.setup_models`")
        log.info("loading FaceLandmarker from %s", task_path)
        opts = mp_vision.FaceLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(task_path)),
            num_faces=1,
            running_mode=mp_vision.RunningMode.IMAGE,
        )
        self._landmarker = mp_vision.FaceLandmarker.create_from_options(opts)
        self._mp = mp
        log.info("iris tracker ready")

    def measure(
        self, image_rgb: np.ndarray, bbox_norm: tuple[float, float, float, float],
        padding: float = 0.35,
    ) -> IrisResult | None:
        """Run FaceLandmarker on a padded crop of `image_rgb` at `bbox_norm`.

        `image_rgb` is a full-frame HxWx3 uint8 array (RGB). Returns None if
        FaceLandmarker can't find a face in the crop (typically profile /
        heavily turned head — caller should fall back to head-pose only).
        """
        h, w = image_rgb.shape[:2]
        x1_n, y1_n, x2_n, y2_n = bbox_norm
        bw = (x2_n - x1_n) * w
        bh = (y2_n - y1_n) * h
        pad_x = bw * padding
        pad_y = bh * padding
        x0 = max(0, int(x1_n * w - pad_x))
        y0 = max(0, int(y1_n * h - pad_y))
        x1 = min(w, int(x2_n * w + pad_x))
        y1 = min(h, int(y2_n * h + pad_y))
        if x1 - x0 < 20 or y1 - y0 < 20:
            return None
        crop = np.ascontiguousarray(image_rgb[y0:y1, x0:x1])
        mp_image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=crop)
        result = self._landmarker.detect(mp_image)
        if not result.face_landmarks:
            return None
        lm = result.face_landmarks[0]
        try:
            yl = _yaw_for_eye(
                lm, _CAM_LEFT_EYE_OUTER, _CAM_LEFT_EYE_INNER, _CAM_LEFT_IRIS,
                crop.shape[1], crop.shape[0],
            )
            yr = _yaw_for_eye(
                lm, _CAM_RIGHT_EYE_OUTER, _CAM_RIGHT_EYE_INNER, _CAM_RIGHT_IRIS,
                crop.shape[1], crop.shape[0],
            )
        except IndexError:
            return None
        return IrisResult(yaw_left=yl, yaw_right=yr)


def _yaw_for_eye(
    landmarks: list[Any],
    outer_idx: int,
    inner_idx: int,
    iris_idxs: tuple[int, int, int, int],
    w: int,
    h: int,
) -> float:
    """Project the iris onto the eye axis (outer → inner corner) and return
    the normalized signed offset from the axis midpoint.

    Using vector projection (not horizontal distance) makes the measurement
    robust to head tilt — a tilted eye whose iris is centered along its own
    axis correctly yields yaw ≈ 0, which the horizontal-only formula was
    missing (e.g. Disaster Girl). Sign convention: negative = iris toward
    outer corner, positive = iris toward inner corner.
    """
    ox, oy = landmarks[outer_idx].x * w, landmarks[outer_idx].y * h
    ix, iy = landmarks[inner_idx].x * w, landmarks[inner_idx].y * h
    ex = sum(landmarks[i].x * w for i in iris_idxs) / len(iris_idxs)
    ey = sum(landmarks[i].y * h for i in iris_idxs) / len(iris_idxs)
    vx, vy = ix - ox, iy - oy
    eye_len_sq = vx * vx + vy * vy
    if eye_len_sq < 1e-6:
        return 0.0
    # t=0 at outer corner, t=1 at inner corner, t=0.5 at eye center.
    t = ((ex - ox) * vx + (ey - oy) * vy) / eye_len_sq
    return t - 0.5
