import * as path from "node:path";
import { startChildServer, type ChildServerHandle, BrainService, logger } from "@brain/core";
import type { NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown } from "@brain/sdk";
import WebSocket from "ws";

const PORT = process.env.VOICE_PORT ?? "8765";
const HOST = process.env.VOICE_HOST ?? "127.0.0.1";
const SERVER_URL = process.env.VOICE_SERVER_URL ?? `http://${HOST}:${PORT}`;
const WS_URL = SERVER_URL.replace(/^http/, "ws") + "/ws/events?session_id=default";
const SERVER_DIR = path.resolve(__dirname, "..", "server");
const VENV_PYTHON = process.platform === "win32"
  ? path.join(SERVER_DIR, ".venv", "Scripts", "python.exe")
  : path.join(SERVER_DIR, ".venv", "bin", "python");
const PYTHON_BIN = process.env.VOICE_PYTHON ?? VENV_PYTHON;

let serverPromise: Promise<ChildServerHandle> | null = null;
let nodeId: string | null = null;
let bridgeWs: WebSocket | null = null;
let bridgeStop = false;

function ensureServer(): Promise<ChildServerHandle> {
  if (serverPromise) return serverPromise;
  const p = startChildServer({
    name: "voice-server",
    healthUrl: `${SERVER_URL}/api/health`,
    command: PYTHON_BIN,
    args: ["-m", "uvicorn", "app.main:app", "--host", HOST, "--port", PORT],
    cwd: SERVER_DIR,
    env: {
      VOICE_ENGINE: process.env.VOICE_ENGINE ?? "real",
    },
    startupTimeoutMs: 60_000,
  });
  serverPromise = p;
  p.catch((err: unknown) => {
    if (serverPromise === p) serverPromise = null;
    logger.error({ err }, "voice node: child server start failed");
  });
  return p;
}

/**
 * Bridge the Python server's `/ws/events` stream onto the brAIn bus.
 *
 * - Each finalized SegmentEvent → published as `voice.transcript` (criticality
 *   raised on non-provisional ones so the brain wakes up).
 * - Each SpeakerNewEvent → `voice.speaker.detected`.
 *
 * Runs as a long-lived background loop with reconnect backoff. Stops when
 * `bridgeStop` is flipped at teardown.
 */
function startEventBridge(): void {
  if (bridgeStop) return;
  let backoffMs = 500;

  const connect = (): void => {
    if (bridgeStop) return;
    const bus = BrainService.current?.bus;
    const id = nodeId;
    if (!bus || !id) {
      // Bus or node id not yet ready (race between onSpawn and module init).
      // Retry shortly.
      setTimeout(connect, 200);
      return;
    }
    const ws = new WebSocket(WS_URL);
    bridgeWs = ws;
    ws.on("open", () => {
      backoffMs = 500;
      logger.info({ url: WS_URL }, "voice bridge: connected");
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const event = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        const type = event.type;
        if (type === "segment") {
          const provisional = Boolean(event.provisional);
          if (provisional) return; // brain wants finalized text only
          bus.publish({
            from: id,
            topic: "voice.transcript",
            type: "text",
            criticality: 4,
            payload: { content: String(event.text ?? "") },
            metadata: event,
          });
        } else if (type === "speaker_new") {
          bus.publish({
            from: id,
            topic: "voice.speaker.detected",
            type: "text",
            criticality: 2,
            payload: { content: `new speaker: ${String(event.name ?? event.speaker_id)}` },
            metadata: event,
          });
        }
      } catch (err) {
        logger.warn({ err }, "voice bridge: malformed event");
      }
    });
    ws.on("close", () => {
      bridgeWs = null;
      if (bridgeStop) return;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 15_000);
    });
    ws.on("error", (err: Error) => {
      logger.debug({ err: err.message }, "voice bridge: ws error (will reconnect)");
    });
  };
  connect();
}

type VoiceControl =
  | { action: "start"; session_id?: string }
  | { action: "stop"; session_id?: string }
  | { action: "status" };

type SpeakerRename = { speaker_id: string; name: string };

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  bridgeStop = false;
  await ensureServer();
  startEventBridge();
};

export const handler: NodeHandler = async (ctx) => {
  await ensureServer();
  // Capture node id lazily as well, in case onSpawn raced with the first
  // message. Idempotent.
  nodeId ??= ctx.node.id;

  for (const msg of ctx.messages) {
    const topic = msg.topic;

    if (topic === "voice.control") {
      const ctrl = msg.payload as unknown as VoiceControl;
      const res = await fetch(`${SERVER_URL}/api/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ctrl),
      });
      const body = (await res.json()) as Record<string, unknown>;
      ctx.publish("voice.status", {
        type: "text",
        criticality: 1,
        payload: { content: JSON.stringify(body) },
        metadata: body,
      });
      continue;
    }

    if (topic === "voice.speaker.rename") {
      const { speaker_id, name } = msg.payload as unknown as SpeakerRename;
      await fetch(`${SERVER_URL}/api/profiles/${speaker_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      continue;
    }
  }
};

export const teardown: NodeTeardown = async () => {
  bridgeStop = true;
  if (bridgeWs) {
    try { bridgeWs.close(); } catch { /* ignore */ }
    bridgeWs = null;
  }
  const p = serverPromise;
  if (!p) return;
  serverPromise = null;
  try {
    const handle = await p;
    await handle.kill("voice node teardown");
  } catch (err) {
    logger.warn({ err }, "voice teardown: child server kill failed");
  }
};

export default handler;
