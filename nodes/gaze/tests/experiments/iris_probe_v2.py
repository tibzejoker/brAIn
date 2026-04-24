"""Hybrid iris probe v2 — crop each InsightFace bbox and run FaceLandmarker
on the crop. This sidesteps FaceLandmarker's group-photo weakness: each
single-face crop is the easy case MediaPipe is tuned for.

Pipeline per fixture:
    1. POST image to /api/detect/base64 → InsightFace bboxes + current engine
       verdict (for comparison with the iris-based verdict)
    2. For each bbox: crop with padding, run FaceLandmarker on crop, read
       iris indices, compute yaw_L / yaw_R in the *crop* coordinate system,
       decide looking_at_camera
    3. Print side-by-side comparison + save an annotated overlay
"""
from __future__ import annotations

import base64
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent
FIXTURE_DIR = TESTS / "fixtures"
OUTPUT_DIR = TESTS / "output"
MANIFEST = TESTS / "fixtures.json"
TASK_FILE = Path("/tmp/face_landmarker.task")
API_URL = "http://127.0.0.1:8766"

# Camera-side indices (x-axis of the rendered image).
CAM_LEFT_EYE_OUTER = 33
CAM_LEFT_EYE_INNER = 133
CAM_LEFT_IRIS = (469, 470, 471, 472)
CAM_RIGHT_EYE_OUTER = 263
CAM_RIGHT_EYE_INNER = 362
CAM_RIGHT_IRIS = (474, 475, 476, 477)

# Padding around InsightFace bbox before running FaceLandmarker.
CROP_PADDING = 0.35

YAW_THRESHOLD = 0.18  # |avg yaw| under this → looking at camera


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


def detect_api(image_bytes: bytes) -> dict[str, Any]:
    payload = json.dumps({
        "image": base64.b64encode(image_bytes).decode("ascii"),
        "remember": False,
        "describe": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{API_URL}/api/detect/base64",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def iris_on_crop(bgr: np.ndarray, landmarker) -> tuple[float, float] | None:
    """Run FaceLandmarker on a pre-cropped single-face BGR array.

    Returns (yaw_L, yaw_R) or None if no face / iris found.
    """
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    result = landmarker.detect(mp_image)
    if not result.face_landmarks:
        return None
    lm = result.face_landmarks[0]
    try:
        yaw_l = _yaw_for_eye(lm, CAM_LEFT_EYE_OUTER, CAM_LEFT_EYE_INNER, CAM_LEFT_IRIS, w, h)
        yaw_r = _yaw_for_eye(lm, CAM_RIGHT_EYE_OUTER, CAM_RIGHT_EYE_INNER, CAM_RIGHT_IRIS, w, h)
    except IndexError:
        return None
    return yaw_l, yaw_r


def crop_face(bgr: np.ndarray, bbox_norm: dict, padding: float) -> tuple[np.ndarray, tuple[int, int, int, int]] | None:
    h, w = bgr.shape[:2]
    x_min = bbox_norm["x_min"] * w
    y_min = bbox_norm["y_min"] * h
    x_max = bbox_norm["x_max"] * w
    y_max = bbox_norm["y_max"] * h
    bw = x_max - x_min
    bh = y_max - y_min
    pad_x = bw * padding
    pad_y = bh * padding
    x0 = max(0, int(x_min - pad_x))
    y0 = max(0, int(y_min - pad_y))
    x1 = min(w, int(x_max + pad_x))
    y1 = min(h, int(y_max + pad_y))
    if x1 - x0 < 20 or y1 - y0 < 20:
        return None
    return bgr[y0:y1, x0:x1].copy(), (x0, y0, x1, y1)


def process_fixture(name: str, path: Path, landmarker, font) -> None:
    bgr = cv2.imread(str(path))
    if bgr is None:
        print(f"[{name}] cannot read {path}")
        return
    image_bytes = path.read_bytes()
    try:
        det = detect_api(image_bytes)
    except urllib.error.URLError as e:
        print(f"[{name}] API error: {e}")
        return

    faces = det.get("faces", [])
    print(f"\n[{name}] {len(faces)} face(s) from InsightFace")
    overlay = bgr.copy()
    rows: list[str] = []

    for face in faces:
        idx = face["face_index"]
        current = (
            "CAM" if face.get("looking_at_camera")
            else face.get("looking_at") or ("scene" if face.get("gaze") else "?")
        )
        crop_result = crop_face(bgr, face["bbox"], CROP_PADDING)
        if crop_result is None:
            rows.append(f"  #{idx} current={current:8s} iris=no-crop")
            continue
        crop, (cx0, cy0, cx1, cy1) = crop_result
        iris = iris_on_crop(crop, landmarker)
        if iris is None:
            rows.append(f"  #{idx} current={current:8s} iris=no-face (turned)")
            cv2.rectangle(overlay, (cx0, cy0), (cx1, cy1), (0, 100, 255), 2)
            continue
        yaw_l, yaw_r = iris
        yaw_avg = (yaw_l + yaw_r) / 2
        verdict = "CAM" if abs(yaw_l) < YAW_THRESHOLD and abs(yaw_r) < YAW_THRESHOLD else "off"
        rows.append(
            f"  #{idx} current={current:8s} iris L={yaw_l:+.2f} R={yaw_r:+.2f} avg={yaw_avg:+.2f} → {verdict}"
        )
        color = (0, 255, 255) if verdict == "CAM" else (255, 165, 0)
        cv2.rectangle(overlay, (cx0, cy0), (cx1, cy1), color, 2)
        cv2.putText(
            overlay, f"#{idx} {verdict} y={yaw_avg:+.2f}",
            (cx0 + 4, cy0 + 24), cv2.FONT_HERSHEY_SIMPLEX,
            max(0.4, (cy1 - cy0) / 250), color, 2,
        )

    for r in rows:
        print(r)

    out = OUTPUT_DIR / f"iris_v2_{name}.png"
    cv2.imwrite(str(out), overlay)
    print(f"  wrote {out.relative_to(TESTS.parent)}")


def main() -> int:
    if not TASK_FILE.exists():
        print(f"missing {TASK_FILE} — run the first probe to download it", file=sys.stderr)
        return 2

    opts = mp_vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(TASK_FILE)),
        num_faces=1,
        running_mode=mp_vision.RunningMode.IMAGE,
    )
    landmarker = mp_vision.FaceLandmarker.create_from_options(opts)
    font = ImageFont.load_default()

    manifest = json.loads(MANIFEST.read_text())
    for fx in manifest["fixtures"]:
        name = fx["name"]
        candidates = list(FIXTURE_DIR.glob(f"{name}.*"))
        if not candidates:
            print(f"[{name}] fixture not downloaded")
            continue
        process_fixture(name, candidates[0], landmarker, font)

    return 0


if __name__ == "__main__":
    sys.exit(main())
