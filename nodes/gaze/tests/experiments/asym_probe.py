"""Standalone validator for the head-turn asymmetry formula.

Runs InsightFace directly on each fixture (bypasses the HTTP server so we
can iterate on the math without restarts), visualizes the 5 landmarks
(eyes/nose/mouth corners) overlaid on each detected face, and prints the
intermediate values the engine uses.

Run:
    server/.venv/bin/python tests/experiments/asym_probe.py
    server/.venv/bin/python tests/experiments/asym_probe.py --only disaster_girl

Outputs tests/output/asym_<name>.png with landmarks + the computed asym
drawn on the face, and a console table with raw numbers so we can sanity-
check the formula (eye axis / nose lateral / mouth lateral) against what
our eyes say.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from insightface.app import FaceAnalysis

HERE = Path(__file__).resolve().parent
TESTS = HERE.parent
FIXTURE_DIR = TESTS / "fixtures"
OUTPUT_DIR = TESTS / "output"
MANIFEST = TESTS / "fixtures.json"
MODELS_DIR = Path(__file__).resolve().parents[2] / "server" / "models"


def compute_asym(kps: np.ndarray) -> dict[str, float]:
    """Re-implements engine._frontality_asym and returns every intermediate.

    kps shape: (5, 2) in pixel coords — left_eye, right_eye, nose,
    left_mouth, right_mouth.
    """
    le, re, nose, lm, rm = kps
    ex_axis = float(re[0] - le[0])
    ey_axis = float(re[1] - le[1])
    eye_len = math.hypot(ex_axis, ey_axis)
    eye_angle_deg = math.degrees(math.atan2(ey_axis, ex_axis))
    if eye_len < 1e-6:
        return {"asym_final": 1.0}
    ux, uy = ex_axis / eye_len, ey_axis / eye_len
    mx, my = (float(le[0]) + float(re[0])) / 2, (float(le[1]) + float(re[1])) / 2
    nose_dx, nose_dy = float(nose[0]) - mx, float(nose[1]) - my
    nose_lat = (nose_dx * ux + nose_dy * uy)  # signed
    mouth_mid_x = (float(lm[0]) + float(rm[0])) / 2
    mouth_mid_y = (float(lm[1]) + float(rm[1])) / 2
    mouth_lat = ((mouth_mid_x - mx) * ux + (mouth_mid_y - my) * uy)
    half = eye_len / 2
    return {
        "eye_len_px": round(eye_len, 1),
        "eye_angle_deg": round(eye_angle_deg, 1),
        "nose_lat": round(nose_lat / half, 2),
        "mouth_lat": round(mouth_lat / half, 2),
        "asym_final": round(max(abs(nose_lat), abs(mouth_lat)) / half, 2),
    }


def draw_viz(bgr: np.ndarray, bbox: tuple[int, int, int, int], kps: np.ndarray, stats: dict[str, float]) -> None:
    x1, y1, x2, y2 = bbox
    asym = stats["asym_final"]
    color = (0, 255, 0) if asym < 0.25 else (0, 165, 255) if asym < 0.5 else (0, 0, 255)
    cv2.rectangle(bgr, (x1, y1), (x2, y2), color, 2)

    # Landmarks: cyan eyes, red nose, green mouth corners
    le, re, nose, lm, rm = kps
    cv2.circle(bgr, (int(le[0]), int(le[1])), 3, (255, 255, 0), -1)
    cv2.circle(bgr, (int(re[0]), int(re[1])), 3, (255, 255, 0), -1)
    cv2.circle(bgr, (int(nose[0]), int(nose[1])), 4, (0, 0, 255), -1)
    cv2.circle(bgr, (int(lm[0]), int(lm[1])), 3, (0, 255, 0), -1)
    cv2.circle(bgr, (int(rm[0]), int(rm[1])), 3, (0, 255, 0), -1)

    # Eye axis line
    cv2.line(bgr, (int(le[0]), int(le[1])), (int(re[0]), int(re[1])), (200, 200, 200), 1)
    # Eye midpoint
    mx, my = int((le[0] + re[0]) / 2), int((le[1] + re[1]) / 2)
    cv2.circle(bgr, (mx, my), 3, (255, 255, 255), -1)
    # Line from eye mid to nose
    cv2.line(bgr, (mx, my), (int(nose[0]), int(nose[1])), (255, 0, 255), 1)

    label = f"asym={asym:.2f} n={stats['nose_lat']:+.2f} m={stats['mouth_lat']:+.2f}"
    scale = max(0.35, (x2 - x1) / 400)
    cv2.putText(bgr, label, (x1 + 2, y2 + 18), cv2.FONT_HERSHEY_SIMPLEX, scale, color, 1)


def process(name: str, path: Path, face_app: FaceAnalysis) -> None:
    bgr = cv2.imread(str(path))
    if bgr is None:
        print(f"[{name}] cannot read {path}")
        return
    h, w = bgr.shape[:2]
    faces = face_app.get(bgr)
    print(f"\n[{name}] {len(faces)} face(s) (InsightFace)")
    print(f"  {'idx':>3} {'asym':>5} {'n_lat':>6} {'m_lat':>6} {'eye_len':>7} {'eye_ang':>7}")
    annotated = bgr.copy()
    for i, f in enumerate(sorted(faces, key=lambda x: -(x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1]))):
        kps = f.kps
        stats = compute_asym(kps)
        print(
            f"  {i:>3} {stats['asym_final']:>5.2f} "
            f"{stats['nose_lat']:>+6.2f} {stats['mouth_lat']:>+6.2f} "
            f"{stats['eye_len_px']:>7} {stats['eye_angle_deg']:>7}"
        )
        bbox = tuple(int(v) for v in f.bbox)
        draw_viz(annotated, bbox, kps, stats)

    out = OUTPUT_DIR / f"asym_{name}.png"
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), annotated)
    print(f"  wrote {out.relative_to(TESTS.parent)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()

    app = FaceAnalysis(
        name="buffalo_l",
        allowed_modules=["detection"],
        root=str(MODELS_DIR),
    )
    app.prepare(ctx_id=-1, det_size=(640, 640))

    manifest = json.loads(MANIFEST.read_text())
    for fx in manifest["fixtures"]:
        name = fx["name"]
        if args.only and name not in args.only:
            continue
        candidates = list(FIXTURE_DIR.glob(f"{name}.*"))
        if not candidates:
            print(f"[{name}] fixture not downloaded")
            continue
        process(name, candidates[0], app)
    return 0


if __name__ == "__main__":
    sys.exit(main())
