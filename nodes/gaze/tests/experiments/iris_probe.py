"""Standalone MediaPipe FaceLandmarker iris-tracking probe (new tasks API).

Runs MediaPipe FaceLandmarker (with iris-refined landmarks, 478 points per
face) on each fixture and reports per-eye horizontal gaze offset (iris
center vs eye inner/outer corners). When the offset is small on both eyes,
the subject is looking into the lens.

Prereqs:
    - /tmp/iris-probe-venv with `mediapipe==0.10.33` + `opencv-python`
    - Download face_landmarker.task once:
        curl -L -o /tmp/face_landmarker.task \\
          https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task

Run:
    /tmp/iris-probe-venv/bin/python tests/experiments/iris_probe.py

Writes tests/output/iris_<name>.png with iris dots + per-face [CAM/off] tag.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent
FIXTURE_DIR = TESTS / "fixtures"
OUTPUT_DIR = TESTS / "output"
MANIFEST = TESTS / "fixtures.json"
TASK_FILE = Path("/tmp/face_landmarker.task")

# MediaPipe FaceMesh indices, camera-side (not subject-side).
# Refine_landmarks adds indices 468-477 (10 iris points, 5 per iris).
CAM_LEFT_EYE_OUTER = 33   # temple-side, camera-left eye
CAM_LEFT_EYE_INNER = 133  # nose-side, camera-left eye
CAM_LEFT_IRIS = (469, 470, 471, 472)
CAM_RIGHT_EYE_OUTER = 263
CAM_RIGHT_EYE_INNER = 362
CAM_RIGHT_IRIS = (474, 475, 476, 477)

YAW_THRESHOLD = 0.12


def _iris_center(lm, idxs, w, h):
    xs = [lm[i].x * w for i in idxs]
    ys = [lm[i].y * h for i in idxs]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _yaw_for_eye(lm, outer, inner, iris_idxs, w, h):
    outer_x = lm[outer].x * w
    inner_x = lm[inner].x * w
    iris_x, _ = _iris_center(lm, iris_idxs, w, h)
    eye_mid_x = (outer_x + inner_x) / 2
    eye_width = abs(outer_x - inner_x)
    if eye_width < 1e-6:
        return 0.0
    return (iris_x - eye_mid_x) / eye_width


def probe(name: str, path: Path, landmarker) -> None:
    bgr = cv2.imread(str(path))
    if bgr is None:
        print(f"[{name}] cannot read {path}")
        return
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_image)

    if not result.face_landmarks:
        print(f"[{name}] no face detected")
        return

    annotated = bgr.copy()
    for i, face_lm in enumerate(result.face_landmarks):
        yaw_l = _yaw_for_eye(face_lm, CAM_LEFT_EYE_OUTER, CAM_LEFT_EYE_INNER, CAM_LEFT_IRIS, w, h)
        yaw_r = _yaw_for_eye(face_lm, CAM_RIGHT_EYE_OUTER, CAM_RIGHT_EYE_INNER, CAM_RIGHT_IRIS, w, h)
        yaw_avg = (yaw_l + yaw_r) / 2
        looking = abs(yaw_l) < YAW_THRESHOLD and abs(yaw_r) < YAW_THRESHOLD

        # Iris dots (cyan)
        for idxs in (CAM_LEFT_IRIS, CAM_RIGHT_IRIS):
            cx, cy = _iris_center(face_lm, idxs, w, h)
            cv2.circle(annotated, (int(cx), int(cy)), 4, (255, 255, 0), -1)
        # Eye corner dots (red)
        for idx in (CAM_LEFT_EYE_OUTER, CAM_LEFT_EYE_INNER, CAM_RIGHT_EYE_OUTER, CAM_RIGHT_EYE_INNER):
            cv2.circle(annotated, (int(face_lm[idx].x * w), int(face_lm[idx].y * h)), 3, (0, 0, 255), -1)

        tag = "CAM" if looking else "off"
        label = f"face{i} yawL={yaw_l:+.2f} yawR={yaw_r:+.2f} avg={yaw_avg:+.2f} [{tag}]"
        print(f"[{name}] {label}")
        nose = face_lm[1]
        cv2.putText(
            annotated, tag,
            (int(nose.x * w) - 15, int(nose.y * h) - 25),
            cv2.FONT_HERSHEY_SIMPLEX, 0.7,
            (0, 255, 255) if looking else (0, 165, 255), 2,
        )

    out = OUTPUT_DIR / f"iris_{name}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), annotated)
    print(f"[{name}] wrote {out.relative_to(TESTS.parent)}")


def main() -> int:
    if not TASK_FILE.exists():
        print(f"missing {TASK_FILE} — download face_landmarker.task first", file=sys.stderr)
        return 2

    opts = mp_vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(TASK_FILE)),
        num_faces=10,
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=False,
        running_mode=mp_vision.RunningMode.IMAGE,
    )
    landmarker = mp_vision.FaceLandmarker.create_from_options(opts)

    manifest = json.loads(MANIFEST.read_text())
    for fx in manifest["fixtures"]:
        name = fx["name"]
        candidates = list(FIXTURE_DIR.glob(f"{name}.*"))
        if not candidates:
            print(f"[{name}] fixture not downloaded — run run_tests.py first")
            continue
        probe(name, candidates[0], landmarker)

    return 0


if __name__ == "__main__":
    sys.exit(main())
