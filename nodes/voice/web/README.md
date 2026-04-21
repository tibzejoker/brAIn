# voice-web

Vite + TypeScript frontend for `voice-server`.

## Dev

```bash
npm install
npm run dev          # http://localhost:5174
```

Vite proxies `/api` and `/ws/*` to `VOICE_SERVER_URL` (default `http://localhost:8765`).
Make sure `voice-server` is running first.

## Architecture

- `src/audio.ts` — getUserMedia + AudioWorklet (resamples to 16 kHz Int16) → WebSocket binary
- `src/api.ts` — REST client (profiles, engine control)
- `src/speakers.ts` — left panel with inline rename
- `src/timeline.ts` — Canvas timeline, one lane per speaker
- `src/transcript.ts` — live transcript list
- `src/main.ts` — wires it all together

## Build

```bash
npm run build        # outputs to dist/
```

The Python server can serve `dist/` directly (TODO once Phase 4 stabilizes).
