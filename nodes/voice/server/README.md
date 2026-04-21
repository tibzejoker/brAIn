# voice-server

Standalone Python service: real-time STT + speaker diarization with persistent identity.

## API

### REST
- `GET  /api/health` — service health
- `GET  /api/profiles` — list known speaker profiles
- `POST /api/profiles` — create profile manually
- `PATCH /api/profiles/{id}` — rename, update color
- `DELETE /api/profiles/{id}` — delete
- `POST /api/profiles/merge` — merge two profiles into one
- `POST /api/profiles/{id}/split` — split profile back into per-segment unknowns
- `POST /api/control` — `{ action: "start" | "stop" | "status" }`
- `GET  /api/session/{id}/timeline` — timeline (segments) for a session

### WebSocket
- `WS /ws/audio?session_id=...` — client sends raw PCM Int16 16kHz mono frames (binary)
- `WS /ws/events?session_id=...` — server pushes JSON events (one per line):
  ```json
  {"type":"segment","session_id":"...","speaker_id":"sp_001","name":"Speaker 1",
   "text":"bonjour","t_start":12.34,"t_end":13.21,"provisional":false,"confidence":0.83}
  {"type":"speaker_new","speaker_id":"sp_007","name":"Speaker 3"}
  {"type":"speaker_renamed","speaker_id":"sp_001","name":"Alice"}
  ```

## Run

### With Docker (recommended)

```bash
# CPU profile (default, works on M-series Mac)
docker compose --profile cpu up

# CUDA profile (NVIDIA GPU)
docker compose --profile cuda up
```

The first launch downloads models (~500 MB cpu / ~2 GB cuda) into the
`./models` volume.

### Without Docker (dev)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.setup_models   # first time only
uvicorn app.main:app --host 0.0.0.0 --port 8765 --reload
```

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `VOICE_ENGINE` | `stub` | `stub` (fake diar, no ML) / `real` (Silero VAD + faster-whisper + WeSpeaker) |
| `VOICE_PORT` | `8765` | HTTP/WS port |
| `VOICE_DB_PATH` | `./data/voice.db` | SQLite profile store |
| `VOICE_MODELS_DIR` | `./models` | where ONNX + Whisper weights are cached |
| `VOICE_STT_MODEL` | `tiny` | `tiny` / `base` / `small` / `medium` / `large-v3` |
| `VOICE_STT_BACKEND` | `auto` | `auto` / `mlx` (Mac) / `faster-whisper` (CPU/CUDA) |
| `VOICE_LANGUAGE` | `fr` | language hint |
| `VOICE_DIAR_MODEL` | `streaming-sortformer-4spk-v2.1` | NeMo Sortformer variant |
| `VOICE_EMBEDDING_MODEL` | `wespeaker-voxceleb-resnet34-LM` | WeSpeaker ONNX |
| `VOICE_MATCH_THRESHOLD` | `0.75` | cosine ≥ → known speaker |
| `VOICE_UNCERTAIN_THRESHOLD` | `0.60` | cosine in [unc, match] → flag uncertain |
| `VOICE_EMA_DECAY` | `0.2` | centroid EMA when match confirmed |
| `VOICE_MIN_SEGMENT_MS` | `1500` | shorter segments don't produce embeddings |
