# gaze

Local face detection + recognition + gaze direction. Two layers:

```
┌─────────────────────────────────────────────────────────────┐
│ server/   — standalone Python web service (FastAPI)         │
│            InsightFace (detect + 512d ArcFace embedding) +  │
│            Gaze-LLE (heatmap + inout) + Moondream (optional │
│            scene description) + MediaPipe iris tracker.     │
│            Persistent face identity via SQLite.             │
│            REST: profiles CRUD, merge, detection, tuning.   │
│            Capture: server-side webcam via cv2.VideoCapture.│
│            Reusable outside brAIn.                           │
├─────────────────────────────────────────────────────────────┤
│ src/      — brAIn node handler (TS)                          │
│            Spawns the Python server as a child at onSpawn,  │
│            kills it cleanly on teardown. Subscribes         │
│            gaze.control / gaze.face.rename. Publishes       │
│            gaze.face.detected / gaze.target.resolved /      │
│            gaze.status.                                      │
│ ui/       — brAIn dashboard panel (vanilla HTML)             │
│            Cam picker, start/stop, live preview (annotated  │
│            JPEG polled at 5 fps), faces panel               │
│            (rename/recolor/merge/delete), tuning sliders.   │
└─────────────────────────────────────────────────────────────┘
```

## Quick start (as brAIn node — recommended)

```bash
pnpm setup:gaze           # one-time: venv + ML models (~500 MB)
pnpm dev:gaze             # API + dashboard + gaze node spawned
                          # Open http://localhost:5173 → click gaze node
```

The handler's `onSpawn` boots `uvicorn` on `:8766` as a child of the API.
A heartbeat thread inside Python polls the parent PID; if the API dies
(clean shutdown, crash, SIGKILL), the child self-terminates within ~2 s.

First model warm-up takes ~15-30 s (Gazelle + InsightFace + MediaPipe).

## Quick start (standalone Python only)

For ad-hoc curl tests or debugging the pipeline in isolation:

```bash
pnpm dev:gaze:server
# uvicorn on :8766 — drive via curl
```

## Local webcam capture

The server opens the host webcam directly (no browser camera path).

```bash
# List openable camera indices (probes 0..4)
curl http://localhost:8766/api/capture/devices

# Start capture (device: int index, fps: 1-30, defaults 0 / 6)
curl -X POST http://localhost:8766/api/capture/start \
  -H 'content-type: application/json' \
  -d '{"device": 0, "fps": 6}'

# Latest annotated frame (bboxes + gaze arrows + labels drawn server-side)
curl http://localhost:8766/api/capture/preview.jpg -o preview.jpg

# Latest detect response (faces, gaze, looking-at, etc.)
curl http://localhost:8766/api/capture/latest

# Stop
curl -X POST http://localhost:8766/api/capture/stop

# Status
curl http://localhost:8766/api/capture/status
```

### macOS permission gotcha

On macOS the very first `start` triggers a TCC camera prompt addressed to
the **parent** process (Terminal.app, iTerm, VSCode, …) — not Python itself.
If the prompt is dismissed or never appears, grant access manually under
**System Settings → Privacy & Security → Camera**.

## Env knobs

| Var | Default | Notes |
|---|---|---|
| `GAZE_PORT` | `8766` | HTTP port |
| `GAZE_DB_PATH` | `./data/gaze.db` | SQLite face profile store |
| `GAZE_MODELS_DIR` | `./models` | Gazelle + InsightFace cache |
| `GAZE_RECOGNIZER` | `buffalo_l` | InsightFace model pack (buffalo_s for lighter) |
| `GAZE_GAZELLE_VARIANT` | `gazelle_dinov2_vitb14_inout` | Gaze model |
| `GAZE_GAZELLE_DEVICE` | `auto` | `mps` / `cuda` / `cpu` |
| `GAZE_DISABLE_GAZELLE` | `0` | `1` to skip gaze direction (faster) |
| `GAZE_DISABLE_DESCRIBE` | `0` | `1` to skip Moondream scene labels |
| `GAZE_DISABLE_IRIS` | `0` | `1` to skip MediaPipe iris signal |

## Visual test harness

`tests/fixtures.json` lists public meme / historic URLs with 1–3 faces and
known expected gaze relations. `tests/run_tests.py` calls the running server
and renders the overlay into `tests/output/<name>.png` for visual review.

```bash
# server must already be running on :8766
server/.venv/bin/python tests/run_tests.py
```
