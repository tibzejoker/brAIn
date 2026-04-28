import type { NodeContext, NodeHandler, TextPayload } from "@brain/sdk";

const SERVER_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:8765";

interface VoiceControl {
  action: "start" | "stop" | "status";
  session_id?: string;
}

interface SpeakerRename {
  speaker_id: string;
  name: string;
}

interface SpeakerMerge {
  source_id: string;
  target_id: string;
}

function parseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function publishStatus(ctx: NodeContext, topic: string, body: unknown): void {
  const payload: TextPayload = { content: JSON.stringify(body) };
  ctx.publish(topic, { type: "text", criticality: 5, payload });
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

export const handler: NodeHandler = async (ctx) => {
  for (const msg of ctx.messages) {
    const content = (msg.payload as TextPayload).content;
    if (!content) continue;

    if (msg.topic === "voice.control") {
      const ctrl = parseJson<VoiceControl>(content);
      if (!ctrl?.action) {
        publishStatus(ctx, "voice.status", { error: "invalid control payload", received: content.slice(0, 120) });
        continue;
      }
      try {
        const { ok, status, body } = await fetchJson(`${SERVER_URL}/api/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(ctrl),
        });
        publishStatus(ctx, "voice.status", { ok, status, body });
      } catch (err) {
        publishStatus(ctx, "voice.status", { error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    if (msg.topic === "voice.speaker.rename") {
      const body = parseJson<SpeakerRename>(content);
      if (!body?.speaker_id || !body.name) {
        publishStatus(ctx, "voice.status", { error: "rename requires speaker_id and name" });
        continue;
      }
      try {
        const res = await fetchJson(`${SERVER_URL}/api/profiles/${encodeURIComponent(body.speaker_id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: body.name }),
        });
        publishStatus(ctx, "voice.status", { renamed: body.speaker_id, to: body.name, ok: res.ok });
      } catch (err) {
        publishStatus(ctx, "voice.status", { error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    if (msg.topic === "voice.speaker.merge") {
      const body = parseJson<SpeakerMerge>(content);
      if (!body?.source_id || !body.target_id) {
        publishStatus(ctx, "voice.status", { error: "merge requires source_id and target_id" });
        continue;
      }
      try {
        const res = await fetchJson(`${SERVER_URL}/api/profiles/merge`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        publishStatus(ctx, "voice.status", { merged: body.source_id, into: body.target_id, ok: res.ok });
      } catch (err) {
        publishStatus(ctx, "voice.status", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
};

export default handler;
