# intent

**"Who is talking to whom?"** — pure-TypeScript brAIn node that listens to
the bus events emitted by the `voice` and `gaze` nodes, correlates speech
segments with the speaker's gaze direction over a short sliding window,
and publishes a structured `intent.detected` per finalized utterance.

```
                    ┌──────────── brAIn bus ────────────┐
voice node   ──────►│ voice.transcript                  │
                    │ voice.speaker.detected            │
gaze node    ──────►│ gaze.target.resolved              │──────►  intent node
                    │                                   │            │
                    │                                   │◄───────────┤
                    │ intent.detected                   │   correlator
                    └───────────────────────────────────┘
```

## Why pure TS

The previous incarnation was a separate Python+Vite proxy that opened
WebSockets / HTTP polling on the voice and gaze servers from outside the
brAIn process. With voice and gaze now bridging their server events
directly onto the brAIn bus, intent doesn't need to talk to those Python
servers at all — it just subscribes to two topics. No Python runtime,
no separate venv, no extra port, just a small TS node.

## Layers

```
src/store.ts        — better-sqlite3 store (persons, intents) at data/intent.db
src/timeline.ts     — in-memory ring buffer (5 min retention)
src/correlator.ts   — port of the legacy correlator algorithm
src/server.ts       — embedded HTTP + WS server on :8767 for the UI
src/handler.ts      — bus subscriber + lifecycle (onSpawn / teardown)
ui/index.html       — persons CRUD + live intents panel (vanilla HTML)
```

## Endpoints (HTTP server on :8767)

| Method | Path                          | Description |
|--------|-------------------------------|-------------|
| GET    | `/api/health`                 | Status |
| GET    | `/api/persons`                | List linked persons |
| POST   | `/api/persons`                | Create (`{name, color?, voice_profile_id?, gaze_profile_id?}`) |
| PATCH  | `/api/persons/:id`            | Update |
| DELETE | `/api/persons/:id`            | Delete |
| GET    | `/api/intents?limit=N`        | History (newest first) |
| DELETE | `/api/intents`                | Wipe history |
| GET    | `/api/timeline?since=epoch`   | In-memory voice + gaze events |
| GET    | `/api/voice/profiles`         | Proxy to voice :8765 |
| GET    | `/api/gaze/profiles`          | Proxy to gaze :8766 |
| WS     | `/ws/intents`                 | Live intent push (one JSON per detection) |

The same operations are also reachable from the bus via
`intent.persons.{create,update,delete}` messages.

## Quick start

```bash
pnpm setup:voice          # one-time: voice server venv + STT models
pnpm setup:gaze           # one-time: gaze server venv + ML models
pnpm dev:intent           # API + dashboard + voice + gaze + intent
                          # http://localhost:5173 → click intent node
```

`dev:intent` seeds three nodes (voice, gaze, intent), so each subsystem's
backing Python server is spawned at node startup and torn down cleanly when
the node is killed (heartbeat + onTeardown — same pattern as voice/gaze).

## Workflow in the UI

1. Start mic capture from the voice node UI, start cam capture from gaze.
2. Once a few voice / face profiles exist (let people speak / appear),
   open the intent UI.
3. Create a person, then bind them to a voice profile (🎙) and a face
   profile (👁) via the dropdowns. Both bindings are required for the
   correlator to credit a segment to a person.
4. When that person speaks, an intent appears in the live feed labeling
   what they are looking at: another person, the camera, a scene
   description (Moondream when describe=ON), or unknown.

## Bus topics

**Subscribes:**
- `voice.transcript` — finalized SegmentEvent metadata
- `gaze.target.resolved` — gaze /api/events row
- `intent.persons.{create,update,delete}` — CRUD via bus

**Publishes:**
- `intent.detected` — one per correlated voice segment
- `intent.persons.changed` — `{kind, person}` after CRUD changes
