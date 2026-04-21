import type { NodeHandler } from "@brain/sdk";

const SERVER_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:8765";

type VoiceControl =
  | { action: "start"; session_id?: string }
  | { action: "stop"; session_id?: string }
  | { action: "status" };

type SpeakerRename = { speaker_id: string; name: string };

export const handler: NodeHandler = async (ctx) => {
  for (const msg of ctx.messages) {
    const topic = msg.topic;

    if (topic === "voice.control") {
      const ctrl = msg.payload as VoiceControl;
      const res = await fetch(`${SERVER_URL}/api/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ctrl),
      });
      ctx.publish("voice.status", await res.json());
      continue;
    }

    if (topic === "voice.speaker.rename") {
      const { speaker_id, name } = msg.payload as SpeakerRename;
      await fetch(`${SERVER_URL}/api/profiles/${speaker_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      continue;
    }
  }
};

export default handler;
