# voice

Real-time speech transcription + speaker diarization with persistent identity.

Two layers:

```
┌─────────────────────────────────────────────────────────────┐
│ server/   — standalone Python web service (FastAPI + WS)    │
│            VAD (Silero) + STT (faster-whisper) + diarization│
│            (WeSpeaker embedding) + persistent identity layer│
│            REST: profiles CRUD, merge, split, rename, tuning│
│            WS: events out (segments)                         │
│            Capture: server-side mic via sounddevice          │
│            Reusable outside brAIn — no @brain/* dependency. │
├─────────────────────────────────────────────────────────────┤
│ src/      — brAIn node handler (TS)                          │
│            Spawns the Python server as a child process at    │
│            node spawn (onSpawn), kills it cleanly at         │
│            teardown. Subscribes voice.control /              │
│            voice.speaker.rename. Publishes voice.transcript  │
│            / voice.speaker.*.                                │
│ ui/       — brAIn dashboard panel (vanilla HTML)             │
│            Speakers (rename/recolor/delete/merge/voiceprints)│
│            timeline canvas, transcript log, tuning sliders.  │
│            Served at /nodes/<id>/ui/ when has_ui: true.      │
└─────────────────────────────────────────────────────────────┘
```

## Why this layout

The voice pipeline is heavy (Python, ML models, GPU optional) and benefits
from running as its own process behind a stable HTTP/WS API. The Python
server is fully usable on its own (curl, scripts, …); the brAIn node is
just one possible controller.

## Quick start (as brAIn node — recommended)

```bash
pnpm setup:voice          # one-time: venv + STT models
pnpm dev:voice            # API + dashboard + voice node spawned
                          # Open http://localhost:5173 → click voice node
```

The node's `onSpawn` boots the Python server as a child of the API process
(`uvicorn` on `:8765`). A heartbeat thread inside the Python process polls
the parent PID; if the API dies (clean shutdown, crash, SIGKILL), the
child self-terminates within ~2 s — no orphans.

## Quick start (standalone Python only)

For ad-hoc curl tests or debugging the pipeline in isolation:

```bash
pnpm dev:voice:server
# uvicorn on :8765 — drive via curl
```

Or via Docker:

```bash
cd server
docker compose --profile cpu up        # M-series Mac / CPU
docker compose --profile cuda up       # NVIDIA GPU
```

## Local microphone capture

The server opens the host microphone directly (no browser audio path).

```bash
# List input devices
curl http://localhost:8765/api/capture/devices

# Start capture (device: int index, name substring, or omit for system default)
curl -X POST http://localhost:8765/api/capture/start \
  -H 'content-type: application/json' \
  -d '{"device": null, "session_id": "default"}'

# Stop
curl -X POST http://localhost:8765/api/capture/stop

# Status
curl http://localhost:8765/api/capture/status
```

While capture is running, segment events stream out of `/ws/events`.

### macOS permission gotcha

On macOS the very first `start` triggers a TCC microphone prompt addressed to
the **parent** process (Terminal.app, iTerm, VSCode, …) — not Python itself.
If the prompt is dismissed or never appears, grant access manually under
**System Settings → Privacy & Security → Microphone**. If you switch
terminals, you'll be asked again for the new parent.

## Status

- [x] Phase 1 — Server scaffold + mic→WS echo pipeline (stub engine)
- [x] Phase 2 — Engine: Silero VAD + faster-whisper + WeSpeaker embedding
  (`VOICE_ENGINE=real`, non-gated models, ~200 MB)
- [x] Phase 3 — Identity: SQLite profiles + cosine match w/ EMA centroids
- [x] Phase 4 — Server-side local capture (sounddevice → engine direct)
- [x] Phase 5 — brAIn integration: spawn-anti-orphan + dashboard UI
- [ ] Future — swap `VadSttEngine` for Streaming Sortformer (4090 target)
