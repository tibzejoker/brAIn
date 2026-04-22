# voice

Real-time speech transcription + speaker diarization with persistent identity.

This package has **three layers**:

```
┌─────────────────────────────────────────────────────────────┐
│ server/   — standalone Python web service (FastAPI + WS)    │
│            STT (Whisper) + diarization (Streaming Sortformer)│
│            + persistent speaker identity layer               │
│            REST: profiles CRUD, merge, split, rename         │
│            WS: audio in (PCM 16kHz), events out (segments)   │
│            Reusable outside brAIn — no @brain/* dependency. │
├─────────────────────────────────────────────────────────────┤
│ web/      — standalone Vite TS frontend                      │
│            Mic capture, timeline, speaker rename UI.         │
│            Talks to server/ via REST + WS.                   │
├─────────────────────────────────────────────────────────────┤
│ src/      — brAIn proxy node (TS)                            │
│            Thin handler that bridges the bus to server's WS. │
│            Subscribes voice.control / voice.speaker.rename.  │
│            Publishes voice.transcript / voice.speaker.*.     │
└─────────────────────────────────────────────────────────────┘
```

## Why this layout

The voice service is intentionally NOT a pure brAIn node. The pipeline is heavy
(Python, ML models, GPU optional) and benefits from running as its own process,
behind a stable HTTP/WS API. The brAIn `voice` node is a thin proxy so the rest
of the project can be wholesale reused outside brAIn (other apps, CLI, etc.).

## Quick start (standalone, no brAIn)

```bash
# Backend (Python)
cd server
docker compose --profile cpu up        # M-series Mac / CPU
# OR
docker compose --profile cuda up       # NVIDIA GPU

# Frontend (Vite)
cd web
npm install
npm run dev                            # http://localhost:5174
```

## Quick start (as brAIn node)

The brAIn proxy node spawns the server as a child process (or connects to an
already-running one via `VOICE_SERVER_URL` env). See `src/handler.ts`.

```bash
# In brAIn root
pnpm dev:api                           # the voice node will appear in registry
```

## Status

This is an early scaffold. Phases:

- [x] Phase 1 — Scaffold: structure + mic→WS echo pipeline runnable (stub engine)
- [x] Phase 2 — Engine: Silero VAD + faster-whisper + WeSpeaker embedding
  (`VOICE_ENGINE=real`, non-gated models, ~200 MB)
- [x] Phase 3 — Identity: SQLite profiles + cosine match w/ EMA centroids
- [x] Phase 4 — UI: Canvas timeline, speaker panel with rename, live transcript
- [ ] Phase 5 — brAIn proxy: WS event bridge to the bus (currently REST-only)
- [ ] Future — swap `VadSttEngine` for Streaming Sortformer (4090 target)
