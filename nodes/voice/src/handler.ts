import * as path from "node:path";
import { startChildServer, type ChildServerHandle, logger } from "@brain/core";
import type { NodeHandler, NodeOnSpawn, NodeTeardown } from "@brain/sdk";

const PORT = process.env.VOICE_PORT ?? "8765";
const HOST = process.env.VOICE_HOST ?? "127.0.0.1";
const SERVER_URL = process.env.VOICE_SERVER_URL ?? `http://${HOST}:${PORT}`;
const SERVER_DIR = path.resolve(__dirname, "..", "server");
// Default to the venv created by `pnpm setup:voice`. Override with VOICE_PYTHON
// (full path to a python interpreter) when running outside the standard venv.
const PYTHON_BIN = process.env.VOICE_PYTHON ?? path.join(SERVER_DIR, ".venv", "bin", "python");

let serverPromise: Promise<ChildServerHandle> | null = null;

function ensureServer(): Promise<ChildServerHandle> {
  if (serverPromise) return serverPromise;
  const p = startChildServer({
    name: "voice-server",
    healthUrl: `${SERVER_URL}/api/health`,
    command: PYTHON_BIN,
    args: ["-m", "uvicorn", "app.main:app", "--host", HOST, "--port", PORT],
    cwd: SERVER_DIR,
    env: {
      // Default to real STT (Silero VAD + faster-whisper + WeSpeaker). The
      // models live under nodes/voice/server/models — installed by
      // `pnpm setup:voice`. Override to "stub" for engine-less tests.
      VOICE_ENGINE: process.env.VOICE_ENGINE ?? "real",
    },
    startupTimeoutMs: 60_000,  // STT model warmup with engine=real can be slow
  });
  serverPromise = p;
  p.catch((err: unknown) => {
    if (serverPromise === p) serverPromise = null;
    logger.error({ err }, "voice node: child server start failed");
  });
  return p;
}

type VoiceControl =
  | { action: "start"; session_id?: string }
  | { action: "stop"; session_id?: string }
  | { action: "status" };

type SpeakerRename = { speaker_id: string; name: string };

export const onSpawn: NodeOnSpawn = async () => {
  await ensureServer();
};

export const handler: NodeHandler = async (ctx) => {
  // Defensive: if onSpawn raced or failed, lazily retry on first message.
  await ensureServer();

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
