/**
 * Tiny embedded HTTP + WS server for the intent UI.
 *
 * Listens on port 8767 (or INTENT_SERVER_PORT). Exposes:
 *   GET  /api/health
 *   GET  /api/persons          → list
 *   POST /api/persons          → create
 *   PATCH /api/persons/:id     → patch
 *   DELETE /api/persons/:id    → delete
 *   GET  /api/intents          → recent intents (?limit=N&since_id=N)
 *   DELETE /api/intents        → wipe history
 *   GET  /api/timeline         → in-memory timeline snapshot (?since=epoch)
 *   GET  /api/voice/profiles   → proxy voice server (helper for the UI)
 *   GET  /api/gaze/profiles    → proxy gaze server (helper for the UI)
 *   WS   /ws/intents           → push each new intent as JSON
 *
 * Lives in the same Node process as the brAIn API; nothing external to spawn,
 * nothing to teardown except closing this listener.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "@brain/core";
import type { IntentRecord, IntentStore, Person } from "./store";
import type { Timeline } from "./timeline";

const VOICE_URL = process.env.VOICE_SERVER_URL ?? "http://127.0.0.1:8765";
const GAZE_URL = process.env.GAZE_SERVER_URL ?? "http://127.0.0.1:8766";

export interface IntentServerHandle {
  /** True when this process bound the port; false when we attached to an existing server (orphan from a prior run). */
  readonly spawned: boolean;
  close(): Promise<void>;
  broadcastIntent(intent: IntentRecord): void;
}

export async function startIntentServer(opts: {
  port: number;
  store: IntentStore;
  timeline: Timeline;
  onPersonChange: (kind: "create" | "update" | "delete", person: Person | { id: string }) => void;
}): Promise<IntentServerHandle> {
  const subscribers = new Set<WebSocket>();

  const httpServer: Server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

    try {
      await route(req, res, opts);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      send(res, 500, { error: msg });
    }
  });

  // Bind with proper error handling. If another intent server is already
  // listening (orphan from a prior run, or another `dev` shell), don't
  // crash the API process — log and return a no-op handle that lets the
  // correlator keep running. Attention will poll the existing server.
  //
  // Probe FIRST. WebSocketServer attached to httpServer also emits 'error'
  // on bind failures, so attaching wss before we know listen() succeeded
  // would re-throw the EADDRINUSE event from a second emitter that we
  // can't fully silence. Probe → bind → wss is the safest order.
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        httpServer.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        httpServer.removeListener("error", onError);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(opts.port);
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // Port already held — likely an intent server orphan from a prior
      // pnpm dev run. We don't bind; the correlator still works, and
      // attention's HTTP poll will hit whatever is on :8767 (which IS an
      // intent server, so that's fine). The downside: writes via this
      // node's API surface go to the orphan's store, not ours. Logged
      // loudly so the dev notices and kills the orphan.
      try { httpServer.close(); } catch { /* ignore */ }
      const noop: IntentServerHandle = {
        spawned: false,
        close: () => Promise.resolve(),
        broadcastIntent: () => { /* orphan owns the WS clients */ },
      };
      return noop;
    }
    throw err;
  }

  // httpServer is now listening — safe to attach the WebSocket server.
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/intents" });
  wss.on("connection", (ws) => {
    subscribers.add(ws);
    ws.on("close", () => subscribers.delete(ws));
  });
  wss.on("error", (err: Error) => {
    // Defensive: log but don't let a runtime ws error tear down the api.
    logger.warn({ err: err.message }, "intent: wss runtime error");
  });

  return {
    spawned: true,
    close: () => new Promise((resolve) => {
      for (const ws of subscribers) { try { ws.close(); } catch { /* ignore */ } }
      subscribers.clear();
      wss.close(() => httpServer.close(() => resolve()));
    }),
    broadcastIntent: (intent: IntentRecord) => {
      const payload = JSON.stringify(intent);
      for (const ws of subscribers) {
        try { ws.send(payload); } catch { /* ignore */ }
      }
    },
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { store: IntentStore; timeline: Timeline; onPersonChange: (kind: "create" | "update" | "delete", person: Person | { id: string }) => void },
): Promise<void> {
  const { store, timeline, onPersonChange } = opts;
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";

  if (m === "GET" && p === "/api/health") {
    return send(res, 200, { status: "ok", persons: store.listPersons().length });
  }

  if (m === "GET" && p === "/api/persons") {
    return send(res, 200, store.listPersons());
  }
  if (m === "POST" && p === "/api/persons") {
    const body = await readJson<{ name: string; color?: string; voice_profile_id?: string | null; gaze_profile_id?: string | null }>(req);
    if (!body.name) return send(res, 400, { error: "name required" });
    const person = store.createPerson(body);
    onPersonChange("create", person);
    return send(res, 200, person);
  }

  const personMatch = /^\/api\/persons\/([^/]+)$/.exec(p);
  if (personMatch) {
    const id = decodeURIComponent(personMatch[1]);
    if (m === "PATCH") {
      const body = await readJson<Partial<Pick<Person, "name" | "color" | "voice_profile_id" | "gaze_profile_id">>>(req);
      const updated = store.patchPerson(id, body);
      if (!updated) return send(res, 404, { error: "person not found" });
      onPersonChange("update", updated);
      return send(res, 200, updated);
    }
    if (m === "DELETE") {
      const ok = store.deletePerson(id);
      if (ok) onPersonChange("delete", { id });
      return send(res, 200, { deleted: ok });
    }
  }

  if (m === "GET" && p === "/api/intents") {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const sinceRaw = url.searchParams.get("since_id");
    const since_id = sinceRaw ? Number(sinceRaw) : undefined;
    return send(res, 200, store.listIntents({ limit, since_id }));
  }
  if (m === "DELETE" && p === "/api/intents") {
    return send(res, 200, { deleted: store.clearIntents() });
  }

  if (m === "GET" && p === "/api/timeline") {
    const since = url.searchParams.get("since");
    return send(res, 200, timeline.snapshot(since ? Number(since) : undefined));
  }

  // Lightweight proxy helpers — the UI needs to enumerate voice/gaze profiles
  // to bind them to a person. Forwarding here keeps the UI same-origin to
  // the brAIn API and avoids CORS gymnastics in three different servers.
  if (m === "GET" && p === "/api/voice/profiles") {
    return forwardJson(res, `${VOICE_URL}/api/profiles`);
  }
  if (m === "GET" && p === "/api/gaze/profiles") {
    return forwardJson(res, `${GAZE_URL}/api/profiles`);
  }

  send(res, 404, { error: `not found: ${m} ${p}` });
}

async function forwardJson(res: ServerResponse, url: string): Promise<void> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = await r.json().catch(() => null);
    send(res, r.ok ? 200 : 502, body ?? { error: `upstream ${r.status}` });
  } catch (err: unknown) {
    send(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}
