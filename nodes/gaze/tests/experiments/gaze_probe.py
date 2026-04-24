"""Combined head-pose + iris probe to estimate world-frame gaze direction.

For each face we compute:
    head_yaw       head turn around vertical, from landmark asymmetry
                   (nose lateral offset / half-eye-distance, signed)
    iris_yaw_L,R   iris offset along eye axis per eye, signed in head frame
                   using the eye's outer→inner axis (t=0 at outer, 1 at
                   inner, yaw = t − 0.5 ∈ [−0.5, +0.5])
    eye_world_yaw  head_yaw + a sign-flipped iris_yaw so that for both eyes
                   the sign convention matches the head (negative = looking
                   camera-left in world frame)

A person compensating a head-turn by rolling their eyes toward the camera
will have head_yaw and the in-head iris offset with OPPOSITE signs, so
their world yaw sums to near zero → we flag them as camera.

Run:
    /tmp/iris-probe-venv/bin/python tests/experiments/gaze_probe.py
    /tmp/iris-probe-venv/bin/python tests/experiments/gaze_probe.py --only disaster_girl
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from insightface.app import FaceAnalysis
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision as mp_vision

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent
FIXTURE_DIR = TESTS / "fixtures"
OUTPUT_DIR = TESTS / "output"
MANIFEST = TESTS / "fixtures.json"
TASK_FILE = Path("/tmp/face_landmarker.task")
MODELS_DIR = Path(__file__).resolve().parents[2] / "server" / "models"

CAM_LEFT_EYE_OUTER = 33
CAM_LEFT_EYE_INNER = 133
CAM_LEFT_IRIS = (469, 470, 471, 472)
CAM_RIGHT_EYE_OUTER = 263
CAM_RIGHT_EYE_INNER = 362
CAM_RIGHT_IRIS = (474, 475, 476, 477)

# How much an iris yaw of 1.0 (iris at eye corner) corresponds to in
# "half-eye-distance" units (the same scale as head_yaw). Rough empirical
# calibration: ±0.5 iris yaw = iris at corner ≈ ±25° gaze ≈ ~0.5 in
# half-eye-distance (matches a head turn sufficient to move nose to the eye).
IRIS_TO_HEAD_SCALE = 1.0

WORLD_YAW_THRESHOLD = 0.30  # in half-eye-distance units, |world_yaw| under → CAM


def head_yaw_from_kps(kps: np.ndarray) -> float:
    le, re, nose, lm, rm = kps
    ex = float(re[0] - le[0])
    ey = float(re[1] - le[1])
    eye_len = math.hypot(ex, ey)
    if eye_len < 1e-6:
        return 0.0
    ux, uy = ex / eye_len, ey / eye_len
    mx = (float(le[0]) + float(re[0])) / 2
    my = (float(le[1]) + float(re[1])) / 2
    nose_lat = (float(nose[0]) - mx) * ux + (float(nose[1]) - my) * uy
    return nose_lat / (eye_len / 2)  # signed: negative = head turned left (camera-right)


def iris_axis_yaw(lm, outer_idx, inner_idx, iris_idxs, w, h) -> float:
    ox, oy = lm[outer_idx].x * w, lm[outer_idx].y * h
    ix, iy = lm[inner_idx].x * w, lm[inner_idx].y * h
    ex = sum(lm[i].x * w for i in iris_idxs) / len(iris_idxs)
    ey = sum(lm[i].y * h for i in iris_idxs) / len(iris_idxs)
    vx, vy = ix - ox, iy - oy
    eye_len_sq = vx * vx + vy * vy
    if eye_len_sq < 1e-6:
        return 0.0
    t = ((ex - ox) * vx + (ey - oy) * vy) / eye_len_sq
    return t - 0.5


def crop_face(bgr: np.ndarray, bbox: tuple[int, int, int, int], padding: float = 0.35) -> tuple[np.ndarray, tuple[int, int, int, int]] | None:
    h, w = bgr.shape[:2]
    x1, y1, x2, y2 = bbox
    bw = x2 - x1
    bh = y2 - y1
    px = int(bw * padding)
    py = int(bh * padding)
    x0, y0 = max(0, x1 - px), max(0, y1 - py)
    x1p, y1p = min(w, x2 + px), min(h, y2 + py)
    if x1p - x0 < 20 or y1p - y0 < 20:
        return None
    return bgr[y0:y1p, x0:x1p].copy(), (x0, y0, x1p, y1p)


def process(name: str, path: Path, face_app, landmarker) -> None:
    bgr = cv2.imread(str(path))
    if bgr is None:
        print(f"[{name}] cannot read {path}")
        return
    faces = face_app.get(bgr)
    if not faces:
        print(f"[{name}] no faces")
        return
    faces_sorted = sorted(faces, key=lambda f: -(f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    print(f"\n[{name}] {len(faces_sorted)} face(s)")
    print(f"  {'idx':>3} {'head_yaw':>9} {'iris_L':>7} {'iris_R':>7} "
          f"{'worldL':>7} {'worldR':>7} {'best':>6} verdict")

    annotated = bgr.copy()
    for i, f in enumerate(faces_sorted):
        kps = f.kps
        bbox = tuple(int(v) for v in f.bbox)
        head_yaw = head_yaw_from_kps(kps)

        crop_result = crop_face(bgr, bbox)
        iris_l_s, iris_r_s = None, None
        if crop_result is not None:
            crop, (cx0, cy0, cx1, cy1) = crop_result
            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = landmarker.detect(mp_img)
            if result.face_landmarks:
                lm = result.face_landmarks[0]
                try:
                    iris_l_s = iris_axis_yaw(
                        lm, CAM_LEFT_EYE_OUTER, CAM_LEFT_EYE_INNER, CAM_LEFT_IRIS,
                        crop.shape[1], crop.shape[0],
                    )
                    iris_r_s = iris_axis_yaw(
                        lm, CAM_RIGHT_EYE_OUTER, CAM_RIGHT_EYE_INNER, CAM_RIGHT_IRIS,
                        crop.shape[1], crop.shape[0],
                    )
                except IndexError:
                    pass

        # World-frame yaw per eye. Sign convention: both eyes should have
        # positive world_yaw when the subject looks at camera-right.
        # For camera-left eye (subject's right eye, outer=33 is at the
        # temple-left), "iris toward inner" (positive iris_L_s) means iris
        # shifted right in image → subject looking camera-right. Matches head
        # sign convention → add directly.
        # For camera-right eye (subject's left eye, outer=263 at temple-right),
        # "iris toward inner" (positive iris_R_s) means iris shifted left in
        # image → subject looking camera-left. Opposite to head sign → flip.
        if iris_l_s is not None:
            world_l = head_yaw + iris_l_s * 2 * IRIS_TO_HEAD_SCALE
        else:
            world_l = None
        if iris_r_s is not None:
            world_r = head_yaw - iris_r_s * 2 * IRIS_TO_HEAD_SCALE
        else:
            world_r = None

        candidates = [v for v in (world_l, world_r) if v is not None]
        best = min(candidates, key=abs) if candidates else None
        verdict = "?" if best is None else ("CAM" if abs(best) < WORLD_YAW_THRESHOLD else "off")

        def fmt(v):  # noqa: ANN001
            return f"{v:+.2f}" if v is not None else "  -  "

        print(
            f"  {i:>3} {head_yaw:>+9.2f} {fmt(iris_l_s):>7} {fmt(iris_r_s):>7} "
            f"{fmt(world_l):>7} {fmt(world_r):>7} {fmt(best):>6} {verdict}"
        )

        color = (0, 255, 0) if verdict == "CAM" else (0, 140, 255) if verdict == "off" else (128, 128, 128)
        cv2.rectangle(annotated, (bbox[0], bbox[1]), (bbox[2], bbox[3]), color, 2)
        label = f"#{i} head={head_yaw:+.2f} best={fmt(best)} {verdict}"
        cv2.putText(annotated, label, (bbox[0] + 2, bbox[3] + 16),
                    cv2.FONT_HERSHEY_SIMPLEX, max(0.35, (bbox[2] - bbox[0]) / 400), color, 1)

    out = OUTPUT_DIR / f"gaze_{name}.png"
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), annotated)
    print(f"  wrote {out.relative_to(TESTS.parent)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()

    if not TASK_FILE.exists():
        print(f"missing {TASK_FILE}", file=sys.stderr)
        return 2

    face_app = FaceAnalysis(name="buffalo_l", allowed_modules=["detection"], root=str(MODELS_DIR))
    face_app.prepare(ctx_id=-1, det_size=(640, 640))

    opts = mp_vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(TASK_FILE)),
        num_faces=1,
        running_mode=mp_vision.RunningMode.IMAGE,
    )
    landmarker = mp_vision.FaceLandmarker.create_from_options(opts)

    manifest = json.loads(MANIFEST.read_text())
    for fx in manifest["fixtures"]:
        name = fx["name"]
        if args.only and name not in args.only:
            continue
        candidates = list(FIXTURE_DIR.glob(f"{name}.*"))
        if not candidates:
            print(f"[{name}] fixture not downloaded")
            continue
        process(name, candidates[0], face_app, landmarker)

    return 0


if __name__ == "__main__":
    sys.exit(main())
