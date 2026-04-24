# gaze

Standalone gaze + face-recognition service. Two subprojects:

- `server/` — Python FastAPI. InsightFace (detection + 512d recognition embedding)
  + Moondream 2 (gaze direction per face). Persistent face identity via SQLite.
- `web/` — Vite UI to test via webcam or uploaded image. Overlays bboxes, gaze
  arrows, and highlights "A looking at B" relations live.

Later a thin brAIn handler + `config.json` will proxy the service to the bus
(mirrors how `nodes/voice/` is wired).

## Quick start

```bash
# Server (port 8766)
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.setup_models            # one-off, downloads ~500 MB
uvicorn app.main:app --port 8766 --reload

# Web (port 5175, proxies /api to :8766)
cd web
npm install
npm run dev
```

Open http://localhost:5175 → click **Start webcam** (or drop an image).

## Env knobs

| Var | Default | Notes |
|---|---|---|
| `GAZE_PORT` | `8766` | HTTP port |
| `GAZE_DB_PATH` | `./data/gaze.db` | SQLite face profile store |
| `GAZE_MODELS_DIR` | `./models` | Moondream + InsightFace cache |
| `GAZE_RECOGNIZER` | `buffalo_l` | InsightFace model pack |
| `GAZE_MOONDREAM_REPO` | `vikhyatk/moondream2` | HF repo id |
| `GAZE_MOONDREAM_REVISION` | `2025-01-09` | revision with detect_gaze |
| `GAZE_MOONDREAM_DEVICE` | `auto` | `mps` / `cuda` / `cpu` (auto picks MPS on Mac) |
| `GAZE_MATCH_THRESHOLD` | `0.42` | cosine ≥ → known face |
| `GAZE_UNCERTAIN_THRESHOLD` | `0.30` | cosine in [unc, match] → uncertain |
| `GAZE_EMA_DECAY` | `0.15` | embedding EMA when match confirmed |
| `GAZE_LOOKING_AT_MARGIN` | `0.05` | bbox inflation (frac of image) when resolving "A looks at B" |

## Visual test harness

`tests/fixtures.json` lists a handful of public meme / historic URLs with 1–3
faces and known expected gaze relations. `tests/run_tests.py` downloads them
(first run only), calls the running server, and re-renders the overlay into
`tests/output/<name>.png` so you can eyeball whether detection matches reality.

```bash
# server must already be running on :8766
server/.venv/bin/python tests/run_tests.py
server/.venv/bin/python tests/run_tests.py --only distracted_boyfriend
server/.venv/bin/python tests/run_tests.py --describe    # Moondream target labels (slower)
```

Downloads go to `tests/fixtures/` and renders to `tests/output/`, both
gitignored — open either folder in Finder to review visually.
