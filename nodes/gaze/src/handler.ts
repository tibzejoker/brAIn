import * as path from "node:path";
import { startChildServer, type ChildServerHandle, BrainService, logger } from "@brain/core";
import type { NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown } from "@brain/sdk";

const PORT = process.env.GAZE_PORT ?? "8766";
const HOST = process.env.GAZE_HOST ?? "127.0.0.1";
const SERVER_URL = process.env.GAZE_SERVER_URL ?? `http://${HOST}:${PORT}`;
const SERVER_DIR = path.resolve(__dirname, "..", "server");
const VENV_PYTHON = process.platform === "win32"
  ? path.join(SERVER_DIR, ".venv", "Scripts", "python.exe")
  : path.join(SERVER_DIR, ".venv", "bin", "python");
const PYTHON_BIN = process.env.GAZE_PYTHON ?? VENV_PYTHON;
const POLL_INTERVAL_MS = Number(process.env.GAZE_POLL_INTERVAL_MS ?? "300");

let serverPromise: Promise<ChildServerHandle> | null = null;
let nodeId: string | null = null;
let pollerTimer: NodeJS.Timeout | null = null;
let pollerCursor = 0;
let pollerStop = false;

function ensureServer(): Promise<ChildServerHandle> {
  if (serverPromise) return serverPromise;
  const p = startChildServer({
    name: "gaze-server",
    healthUrl: `${SERVER_URL}/api/health`,
    command: PYTHON_BIN,
    args: ["-m", "uvicorn", "app.main:app", "--host", HOST, "--port", PORT],
    cwd: SERVER_DIR,
    startupTimeoutMs: 120_000,
  });
  serverPromise = p;
  p.catch((err: unknown) => {
    if (serverPromise === p) serverPromise = null;
    logger.error({ err }, "gaze node: child server start failed");
  });
  return p;
}

interface GazeEventRow {
  id: number;
  ts: string;
  source_profile_id: string | null;
  target_type: string;
  target_profile_id: string | null;
  description: string | null;
  gaze_x: number | null;
  gaze_y: number | null;
}

/**
 * Poll the Python server's `/api/events?since_id=N` and republish each row
 * onto the brAIn bus as `gaze.target.resolved`. Idempotent: only events
 * past the last seen id are forwarded.
 */
function startEventPoller(): void {
  if (pollerStop) return;
  const tick = async (): Promise<void> => {
    if (isStopped()) return;
    const bus = BrainService.current?.bus;
    if (!bus || !nodeId) {
      pollerTimer = setTimeout(tick, POLL_INTERVAL_MS);
      return;
    }
    try {
      const url = `${SERVER_URL}/api/events?limit=100${pollerCursor ? `&since_id=${pollerCursor}` : ""}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const rows = (await res.json()) as GazeEventRow[];
        for (const row of rows) {
          if (row.id > pollerCursor) pollerCursor = row.id;
          bus.publish({
            from: nodeId,
            topic: "gaze.target.resolved",
            type: "text",
            criticality: 2,
            payload: {
              content: `${row.source_profile_id ?? "?"} → ${row.target_type}${row.target_profile_id ? `:${row.target_profile_id}` : ""}${row.description ? ` (${row.description})` : ""}`,
            },
            metadata: row as unknown as Record<string, unknown>,
          });
        }
      }
    } catch (err) {
      logger.debug({ err }, "gaze poller: tick failed (will retry)");
    }
    if (!isStopped()) pollerTimer = setTimeout(tick, POLL_INTERVAL_MS);
  };
  void tick();
}

function isStopped(): boolean { return pollerStop; }

type GazeControl =
  | { action: "start"; device?: number; fps?: number }
  | { action: "stop" }
  | { action: "status" };

type FaceRename = { profile_id: string; name: string };

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  pollerStop = false;
  pollerCursor = 0;
  await ensureServer();
  startEventPoller();
};

export const handler: NodeHandler = async (ctx) => {
  await ensureServer();
  nodeId ??= ctx.node.id;

  for (const msg of ctx.messages) {
    const topic = msg.topic;

    if (topic === "gaze.control") {
      const ctrl = msg.payload as unknown as GazeControl;
      if (ctrl.action === "start") {
        const res = await fetch(`${SERVER_URL}/api/capture/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device: ctrl.device ?? 0, fps: ctrl.fps ?? 6 }),
        });
        const body = (await res.json()) as Record<string, unknown>;
        ctx.publish("gaze.status", {
          type: "text", criticality: 1,
          payload: { content: JSON.stringify(body) }, metadata: body,
        });
        continue;
      }
      if (ctrl.action === "stop") {
        const res = await fetch(`${SERVER_URL}/api/capture/stop`, { method: "POST" });
        const body = (await res.json()) as Record<string, unknown>;
        ctx.publish("gaze.status", {
          type: "text", criticality: 1,
          payload: { content: JSON.stringify(body) }, metadata: body,
        });
        continue;
      }
      const res = await fetch(`${SERVER_URL}/api/capture/status`);
      const body = (await res.json()) as Record<string, unknown>;
      ctx.publish("gaze.status", {
        type: "text", criticality: 1,
        payload: { content: JSON.stringify(body) }, metadata: body,
      });
      continue;
    }

    if (topic === "gaze.face.rename") {
      const { profile_id, name } = msg.payload as unknown as FaceRename;
      await fetch(`${SERVER_URL}/api/profiles/${encodeURIComponent(profile_id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      continue;
    }
  }
};

export const teardown: NodeTeardown = async () => {
  pollerStop = true;
  if (pollerTimer) {
    clearTimeout(pollerTimer);
    pollerTimer = null;
  }
  const p = serverPromise;
  if (!p) return;
  serverPromise = null;
  try {
    const handle = await p;
    await handle.kill("gaze node teardown");
  } catch (err) {
    logger.warn({ err }, "gaze teardown: child server kill failed");
  }
};

export default handler;
