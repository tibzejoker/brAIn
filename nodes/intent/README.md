# intent

**"Who is talking to whom?"** — standalone Python+Vite proxy that sits in front
of the voice and gaze servers, correlates their events over a short sliding
window, and emits structured intent records.

Voice and gaze identities stay independent (each server owns its own profile
DB); the intent node stores a small `persons` table that links a voice
profile id to a gaze profile id under a single human name. Profile CRUD on
both upstream servers is **proxied transparently** so the UI can rename /
merge / delete voice and face profiles without leaving the intent tab.

## Pipeline

```
  voice:8765  ── ws://ws/events ──┐
                                   ├──►  intent engine  ──►  /api/intents + /ws/intents
  gaze:8766   ──  /api/events   ──┘                    ──►  /api/timeline
                                                       ──►  SQLite (persisted intents)
```

- **VoiceClient** holds a persistent WS to `/ws/events` and ingests
  finalized `SegmentEvent`s.
- **GazeEventPoller** polls gaze `/api/events?since_id=N` every `gaze_poll_interval_s`.
- **IntentCorrelator** — on each finalized voice segment, looks at gaze
  events from the same *linked person* in the window
  `[t_start − corr_pre_s, t_end + corr_post_s]`, picks the dominant gaze
  target, and writes an intent row.

Target kinds: `person` (linked face), `camera` (speaker addresses the
viewer directly), `scene` (gaze landed on the environment, Moondream
description carried over when available), `unknown` (no confident gaze).

## Quick start

Both voice and gaze servers must already be running for the timeline to
have anything to correlate.

```bash
pnpm setup:intent     # python venv + npm install
pnpm dev:gaze &       # face tracking + iris
pnpm dev:voice &      # STT + diarization
pnpm dev:intent       # intent proxy + UI (port 5176)
```

Open <http://localhost:5176>.

1. **Persons panel** (left) — create a person, then link it to a voice
   profile (from `voice`) and a face profile (from `gaze`) via the two
   dropdowns. The name you set here is the canonical name used in intent
   records; renaming it here does NOT rename the underlying voice/face
   profiles (use the voice / gaze tabs for those — or use the proxy
   endpoints described below).
2. **Timeline** (center) — one row per person, colored speaking bars
   (voice segments), gaze-target dots, and lines connecting a speaker to
   whomever they looked at.
3. **Live intents** (right) — newest intents stream in via
   `/ws/intents`.

## Env knobs

| Var | Default | Notes |
|---|---|---|
| `INTENT_PORT` | `8767` | HTTP + WS port |
| `INTENT_DB_PATH` | `./data/intent.db` | SQLite persons + intents |
| `INTENT_VOICE_URL` | `http://127.0.0.1:8765` | voice node root |
| `INTENT_GAZE_URL` | `http://127.0.0.1:8766` | gaze node root |
| `INTENT_VOICE_SESSION` | `default` | voice `/ws/events?session_id=` |
| `INTENT_CORR_PRE_S` | `0.5` | gaze window before segment start |
| `INTENT_CORR_POST_S` | `0.3` | gaze window after segment end |
| `INTENT_GAZE_POLL_INTERVAL_S` | `0.5` | gaze events polling cadence |
| `INTENT_TIMELINE_RETENTION_S` | `300.0` | rolling buffer for timeline view |

## Endpoints

- `GET /api/health` — status + upstream reachability
- `GET|POST|PATCH|DELETE /api/persons[...]` — link CRUD
- `GET /api/intents?since_id=N&limit=200` — recent intents
- `GET /api/timeline?window_s=60` — raw voice + gaze events for the viz
- `WS /ws/intents` — live stream of newly-computed intents
- `* /api/voice/*` → transparent proxy to `voice:8765/api/*`
- `* /api/gaze/*` → transparent proxy to `gaze:8766/api/*`

Later, a brAIn thin handler will wrap this whole thing onto the pub/sub
bus (same pattern as voice / gaze plan to).
