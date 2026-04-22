# gaze-server

Standalone Python service: face detection + recognition (InsightFace, ArcFace
R100) + per-face gaze direction (Moondream 2). Persistent face identity in
SQLite, mirroring the voice-server contract.

## API

### REST

- `GET  /api/health` — service + gaze model readiness
- `GET  /api/profiles` — list known face profiles
- `POST /api/profiles` — create profile manually `{ name, color? }`
- `PATCH /api/profiles/{id}` — rename, recolor
- `DELETE /api/profiles/{id}` — delete a profile (and its faceprints)
- `DELETE /api/profiles` — wipe all profiles
- `POST /api/profiles/merge` — merge two profiles `{ source_id, target_id }`
- `GET  /api/profiles/{id}/faceprints` — list faceprints (appearance modes) for a profile
- `POST /api/faceprints/{id}/extract` — extract a faceprint into its own profile
- `DELETE /api/faceprints/{id}` — delete a specific faceprint
- `GET  /api/tuning` — current thresholds
- `PATCH /api/tuning` — set thresholds (`match_threshold`, `uncertain_threshold`, `ema_decay`, `looking_at_margin`)
- `POST /api/detect` — `multipart/form-data` with `image=@photo.jpg` field
- `POST /api/detect/base64` — `{ image: "data:image/jpeg;base64,...", remember?: bool }`

Detection response:
```json
{
  "width": 1280,
  "height": 720,
  "faces": [
    {
      "face_index": 0,
      "profile_id": "face_ab12cd34",
      "name": "Face 1",
      "color": "#f59e0b",
      "bbox": { "x_min": 0.1, "y_min": 0.2, "x_max": 0.25, "y_max": 0.45 },
      "gaze": { "x": 0.72, "y": 0.35 },
      "looking_at": "face_ef56gh78",
      "match_confidence": 0.81,
      "provisional": false
    }
  ],
  "elapsed_ms": { "detect": 24.1, "match": 1.2, "gaze": 1830.5 }
}
```

## Run

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.setup_models           # one-off (~2 GB)
uvicorn app.main:app --port 8766 --reload
```

To skip Moondream (recognition-only mode for testing identity without gaze):
```bash
GAZE_DISABLE_GAZE_MODEL=1 uvicorn app.main:app --port 8766 --reload
```

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `GAZE_PORT` | `8766` | HTTP port |
| `GAZE_DB_PATH` | `./data/gaze.db` | SQLite profile store |
| `GAZE_MODELS_DIR` | `./models` | Moondream + InsightFace cache |
| `GAZE_RECOGNIZER` | `buffalo_l` | InsightFace pack (`buffalo_l` / `buffalo_s`) |
| `GAZE_DET_SIZE` | `640` | detector input resolution |
| `GAZE_MOONDREAM_REPO` | `vikhyatk/moondream2` | HF repo id |
| `GAZE_MOONDREAM_REVISION` | `2025-01-09` | first revision shipping `detect_gaze` |
| `GAZE_MOONDREAM_DEVICE` | `auto` | `mps` / `cuda` / `cpu` |
| `GAZE_MATCH_THRESHOLD` | `0.42` | cosine ≥ → known face |
| `GAZE_UNCERTAIN_THRESHOLD` | `0.30` | cosine in [unc, match] → provisional |
| `GAZE_EMA_DECAY` | `0.15` | centroid update rate when match confirmed |
| `GAZE_LOOKING_AT_MARGIN` | `0.05` | bbox inflation when resolving "A looks at B" |
| `GAZE_DISABLE_GAZE_MODEL` | `0` | set to `1` to boot without Moondream |
