"""Visual regression harness for the gaze node.

Downloads the image set described in ``fixtures.json``, posts each to
``/api/detect/base64``, and renders the detection overlay (bbox / gaze arrow /
target halo / camera ring) onto a copy of the image. The annotated result is
written to ``tests/output/<name>.png`` so a human can eyeball whether the
detection matches reality.

Usage
-----
    .venv/bin/python tests/run_tests.py
    .venv/bin/python tests/run_tests.py --only distracted_boyfriend
    .venv/bin/python tests/run_tests.py --api-url http://127.0.0.1:8766
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FIXTURE_DIR = HERE / "fixtures"
OUTPUT_DIR = HERE / "output"
MANIFEST = HERE / "fixtures.json"

DEFAULT_COLOR = "#f59e0b"
CAMERA_COLOR = "#22d3ee"


def _ua_request(url: str) -> urllib.request.Request:
    # Wikipedia blocks requests without a UA.
    return urllib.request.Request(url, headers={"User-Agent": "brAIn-gaze-tests/1.0"})


def download_if_missing(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {url}")
    with urllib.request.urlopen(_ua_request(url), timeout=30) as resp:
        dest.write_bytes(resp.read())


def post_detect(api_url: str, image_bytes: bytes, describe: bool) -> dict[str, Any]:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    payload = json.dumps({
        "image": b64,
        "remember": False,
        "describe": describe,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url.rstrip('/')}/api/detect/base64",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e


def _load_font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _draw_dashed_rect(
    draw: ImageDraw.ImageDraw,
    xy: tuple[float, float, float, float],
    color: str,
    width: int = 2,
    dash: tuple[int, int] = (6, 4),
) -> None:
    x0, y0, x1, y1 = xy
    on, off = dash
    total = on + off
    for sx, sy, ex, ey in ((x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)):
        length = math.hypot(ex - sx, ey - sy)
        if length == 0:
            continue
        dx, dy = (ex - sx) / length, (ey - sy) / length
        t = 0.0
        while t < length:
            seg_end = min(t + on, length)
            draw.line(
                [(sx + dx * t, sy + dy * t), (sx + dx * seg_end, sy + dy * seg_end)],
                fill=color,
                width=width,
            )
            t += total


def _draw_arrow(
    draw: ImageDraw.ImageDraw,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    color: str,
    scale: float = 1.0,
) -> None:
    line_w = max(2, int(3 * scale))
    draw.line([(x0, y0), (x1, y1)], fill=color, width=line_w)
    angle = math.atan2(y1 - y0, x1 - x0)
    head = max(6, 11 * scale)
    hp1 = (x1 - head * math.cos(angle - math.pi / 6), y1 - head * math.sin(angle - math.pi / 6))
    hp2 = (x1 - head * math.cos(angle + math.pi / 6), y1 - head * math.sin(angle + math.pi / 6))
    draw.polygon([(x1, y1), hp1, hp2], fill=color)
    r = max(4, 7 * scale)
    draw.ellipse([(x1 - r, y1 - r), (x1 + r, y1 + r)], fill=color, outline="#0f172a", width=1)


def _label(
    draw: ImageDraw.ImageDraw,
    text: str,
    x: float,
    y: float,
    color: str,
    font: ImageFont.ImageFont,
) -> None:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    pad_x, pad_y = 5, 3
    box_w = right - left + pad_x * 2
    box_h = bottom - top + pad_y * 2
    bx0, by0 = x, y - box_h
    draw.rectangle([bx0, by0, bx0 + box_w, by0 + box_h], fill=color)
    draw.text((bx0 + pad_x, by0 + pad_y - top), text, fill="#0f172a", font=font)


def render_overlay(image: Image.Image, result: dict[str, Any]) -> Image.Image:
    canvas = image.convert("RGB").copy()
    draw = ImageDraw.Draw(canvas, "RGBA")
    w, h = canvas.size
    image_min = min(w, h)

    faces = result.get("faces", [])
    by_index = {f["face_index"]: f for f in faces}
    by_profile = {f["profile_id"]: f for f in faces if f.get("profile_id")}

    for face in faces:
        color = face.get("color") or DEFAULT_COLOR
        bb = face["bbox"]
        x0, y0 = bb["x_min"] * w, bb["y_min"] * h
        x1, y1 = bb["x_max"] * w, bb["y_max"] * h
        face_side = min(x1 - x0, y1 - y0)
        if face.get("provisional"):
            _draw_dashed_rect(draw, (x0, y0, x1, y1), color, width=2, dash=(4, 4))
        else:
            draw.rectangle([x0, y0, x1, y1], outline=color, width=2)

        if face.get("looking_at_camera"):
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            r = max(x1 - x0, y1 - y0) * 0.62
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=CAMERA_COLOR, width=3)

        # Label font scales with face size; small faces get a compact label to
        # keep overlays readable on group photos without hiding any face.
        font_size = max(9, min(int(image_min * 0.022), int(face_side * 0.32)))
        font = _load_font(font_size)
        compact = face_side < image_min * 0.12
        if compact:
            if face.get("looking_at_camera"):
                tag = "cam"
            elif face.get("looking_at"):
                tag = "->" + face["looking_at"].replace("face_", "")
            elif face.get("gaze"):
                tag = "sc"
            else:
                tag = "?"
            label = f"#{face['face_index']} {tag}"
        else:
            name = face.get("name") or f"Face {face['face_index']}"
            conf = face.get("match_confidence") or 0.0
            conf_s = f" {int(conf * 100)}%" if conf > 0 else ""
            eye_s = " eye" if face.get("looking_at_camera") else ""
            peak = face.get("gaze_peak")
            peak_s = f" p={peak:.2f}" if peak is not None else ""
            iris = face.get("iris_yaw")
            iris_s = f" i={iris:.2f}" if iris is not None else ""
            label = f"{name}{conf_s}{eye_s}{peak_s}{iris_s}"
        _label(draw, label, x0, y0, color, font)

        eye = face.get("eye_center")
        eye_x = eye["x"] * w if eye else (x0 + x1) / 2
        eye_y = eye["y"] * h if eye else y0 + (y1 - y0) * 0.4

        gaze = face.get("gaze")
        if gaze and not face.get("looking_at_camera"):
            gx, gy = gaze["x"] * w, gaze["y"] * h
            arrow_scale = min(1.0, face_side / (image_min * 0.18))
            _draw_arrow(draw, eye_x, eye_y, gx, gy, color, scale=arrow_scale)
            desc = face.get("looking_at_description")
            if desc:
                _label(draw, desc, gx + 12, gy + 20, color, font)

        target_ref = face.get("looking_at")
        if target_ref:
            target = None
            if target_ref.startswith("face_"):
                try:
                    idx = int(target_ref.split("_", 1)[1])
                    target = by_index.get(idx)
                except (ValueError, IndexError):
                    target = None
            if target is None and target_ref in by_profile:
                target = by_profile[target_ref]
            if target is not None:
                tbb = target["bbox"]
                tx0, ty0 = tbb["x_min"] * w - 6, tbb["y_min"] * h - 6
                tx1, ty1 = tbb["x_max"] * w + 6, tbb["y_max"] * h + 6
                _draw_dashed_rect(draw, (tx0, ty0, tx1, ty1), color, width=3, dash=(8, 5))

    return canvas


def summarize(fixture: dict[str, Any], result: dict[str, Any]) -> str:
    faces = result.get("faces", [])
    n = len(faces)
    want = fixture.get("expected_faces")
    face_bits = []
    for f in faces:
        idx = f["face_index"]
        bits = [f"#{idx}"]
        if f.get("looking_at_camera"):
            bits.append("camera")
        elif f.get("looking_at"):
            bits.append(f"->{f['looking_at']}")
        elif f.get("gaze"):
            bits.append("scene")
        else:
            bits.append("unresolved")
        io = f.get("inout_score")
        if io is not None:
            bits.append(f"io={io:.2f}")
        peak = f.get("gaze_peak")
        if peak is not None:
            bits.append(f"p={peak:.2f}")
        face_bits.append("(" + " ".join(bits) + ")")
    tag = "OK" if want is None or want == n else f"expected {want} faces, got {n}"
    return f"{n} faces [{tag}] {' '.join(face_bits)}"


def _keep_top_n(result: dict[str, Any], top_n: int | None) -> dict[str, Any]:
    if top_n is None:
        return result
    faces = sorted(
        result.get("faces", []),
        key=lambda f: (f["bbox"]["x_max"] - f["bbox"]["x_min"])
        * (f["bbox"]["y_max"] - f["bbox"]["y_min"]),
        reverse=True,
    )[:top_n]
    return {**result, "faces": faces}


def run(api_url: str, only: list[str] | None, describe: bool, top_n: int | None) -> int:
    manifest = json.loads(MANIFEST.read_text())
    fixtures = manifest["fixtures"]
    if only:
        fixtures = [f for f in fixtures if f["name"] in only]
        if not fixtures:
            print(f"no fixture matched {only}", file=sys.stderr)
            return 2

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    failures = 0
    for fx in fixtures:
        name = fx["name"]
        url = fx["url"]
        ext = Path(url).suffix.split("?")[0] or ".jpg"
        src = FIXTURE_DIR / f"{name}{ext}"
        print(f"\n[{name}] {fx['description']}")
        try:
            download_if_missing(url, src)
            image_bytes = src.read_bytes()
            result = post_detect(api_url, image_bytes, describe=describe)
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL: {e}")
            failures += 1
            continue

        print("  " + summarize(fx, result))
        image = Image.open(src)
        render_result = _keep_top_n(result, fx.get("render_top", top_n))
        overlay = render_overlay(image, render_result)
        out = OUTPUT_DIR / f"{name}.png"
        overlay.save(out)
        print(f"  wrote {out.relative_to(HERE.parent)}")

    print(f"\ndone. {len(fixtures) - failures}/{len(fixtures)} ok.")
    return 0 if failures == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default="http://127.0.0.1:8766")
    parser.add_argument("--only", nargs="*", help="filter fixture names")
    parser.add_argument(
        "--describe",
        action="store_true",
        help="ask Moondream to label each gaze target (slower)",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=None,
        help="render only the N largest faces (per-fixture render_top overrides)",
    )
    args = parser.parse_args()
    return run(args.api_url, args.only, args.describe, args.top_n)


if __name__ == "__main__":
    raise SystemExit(main())
