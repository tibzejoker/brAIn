/**
 * Intent node — pure-TS bus consumer.
 *
 * Subscribes to:
 *   - voice.transcript          (finalized SegmentEvent metadata)
 *   - gaze.target.resolved      (gaze /api/events row metadata)
 *   - intent.persons.*          (CRUD via bus, mirror of HTTP API)
 *
 * Publishes:
 *   - intent.detected           (one per correlated voice segment)
 *   - intent.persons.changed    (after create/update/delete)
 *
 * Owns:
 *   - SQLite at data/intent.db (persons + intents history)
 *   - HTTP+WS server on port 8767 (UI surface, mirror of legacy intent server)
 *
 * No Python child process. The Python code under nodes/intent/server is
 * superseded — voice and gaze handlers now bridge their own server events
 * onto the brAIn bus, and this node correlates them entirely in TS.
 */
import * as path from "node:path";
import * as fs from "node:fs";
import { BrainService, logger } from "@brain/core";
import type { NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown } from "@brain/sdk";
import { IntentStore, type Person } from "./store";
import { Timeline, type GazeEvent, type VoiceSegment } from "./timeline";
import { IntentCorrelator, DEFAULT_CORRELATOR_CONFIG } from "./correlator";
import { startIntentServer, type IntentServerHandle } from "./server";

const SERVER_PORT = Number(process.env.INTENT_SERVER_PORT ?? "8767");
const DB_DIR = process.env.INTENT_DB_DIR
  ?? path.resolve(__dirname, "..", "..", "..", "data");
const DB_PATH = path.join(DB_DIR, "intent.db");

let nodeId: string | null = null;
let store: IntentStore | null = null;
let timeline: Timeline | null = null;
let correlator: IntentCorrelator | null = null;
let server: IntentServerHandle | null = null;
let serverBoot: Promise<void> | null = null;
let pruneTimer: NodeJS.Timeout | null = null;

function bus(): ReturnType<typeof getBusOrNull> { return getBusOrNull(); }
function getBusOrNull(): NonNullable<typeof BrainService.current>["bus"] | null {
  return BrainService.current?.bus ?? null;
}

function publish(topic: string, payload: Record<string, unknown>, criticality = 2): void {
  const b = bus();
  if (!b || !nodeId) return;
  b.publish({
    from: nodeId,
    topic,
    type: "text",
    criticality,
    payload: { content: JSON.stringify(payload) },
    metadata: payload,
  });
}

function ensureBoot(): Promise<void> {
  if (serverBoot) return serverBoot;
  fs.mkdirSync(DB_DIR, { recursive: true });
  store = new IntentStore(DB_PATH);
  timeline = new Timeline();
  correlator = new IntentCorrelator(
    store, timeline, DEFAULT_CORRELATOR_CONFIG,
    (intent) => {
      server?.broadcastIntent(intent);
      publish("intent.detected", intent as unknown as Record<string, unknown>, 4);
    },
  );
  pruneTimer = setInterval(() => timeline?.prune(Date.now() / 1000), 30_000);
  serverBoot = startIntentServer({
    port: SERVER_PORT,
    store,
    timeline,
    onPersonChange: (kind, person) => {
      publish("intent.persons.changed", { kind, person });
    },
  }).then((handle) => {
    server = handle;
    if (handle.spawned) {
      logger.info({ port: SERVER_PORT, db: DB_PATH }, "intent node: server listening");
    } else {
      logger.warn(
        { port: SERVER_PORT, db: DB_PATH },
        "intent node: port already in use — attached to existing server (likely an orphan from a prior run; correlator runs anyway, persons writes go to the orphan's store)",
      );
    }
  });
  return serverBoot;
}

function ingestVoiceTranscript(metadata: Record<string, unknown>): void {
  if (!store || !timeline || !correlator) return;
  const voicePid = String(metadata.speaker_id ?? "");
  if (!voicePid) return;
  const provisional = Boolean(metadata.provisional);
  const linked = store.findByVoice(voicePid);
  const seg: VoiceSegment = {
    ts: Date.now() / 1000,
    voice_profile_id: voicePid,
    voice_name: String(metadata.name ?? ""),
    text: String(metadata.text ?? ""),
    t_start: Number(metadata.t_start ?? 0),
    t_end: Number(metadata.t_end ?? 0),
    confidence: Number(metadata.confidence ?? 0),
    provisional,
    person_id: linked?.id ?? null,
    ts_end: metadata.ts_end !== null && metadata.ts_end !== undefined ? Number(metadata.ts_end) : null,
  };
  timeline.addVoice(seg);
  if (!provisional && seg.person_id) correlator.onSegment(seg);
}

function ingestGazeEvent(metadata: Record<string, unknown>): void {
  if (!store || !timeline) return;
  const sourceGid = (metadata.source_profile_id as string | null) ?? null;
  const targetGid = (metadata.target_profile_id as string | null) ?? null;
  const sourceP = sourceGid ? store.findByGaze(sourceGid) : null;
  const targetP = targetGid ? store.findByGaze(targetGid) : null;
  const ts = parseIsoEpoch(metadata.ts as string | undefined) ?? Date.now() / 1000;
  const ev: GazeEvent = {
    ts,
    target_kind: String(metadata.target_type ?? "unknown"),
    source_gaze_profile_id: sourceGid,
    target_gaze_profile_id: targetGid,
    description: (metadata.description as string | null) ?? null,
    gaze_x: (metadata.gaze_x as number | null) ?? null,
    gaze_y: (metadata.gaze_y as number | null) ?? null,
    source_person_id: sourceP?.id ?? null,
    target_person_id: targetP?.id ?? null,
  };
  timeline.addGaze(ev);
}

function parseIsoEpoch(s?: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t / 1000 : null;
}

function applyPersonCommand(topic: string, payload: Record<string, unknown>): void {
  if (!store) return;
  if (topic === "intent.persons.create") {
    const p = store.createPerson({
      name: String(payload.name ?? "Unknown"),
      color: payload.color as string | undefined,
      voice_profile_id: (payload.voice_profile_id as string | null | undefined) ?? null,
      gaze_profile_id: (payload.gaze_profile_id as string | null | undefined) ?? null,
    });
    publish("intent.persons.changed", { kind: "create", person: p });
  } else if (topic === "intent.persons.update") {
    const id = String(payload.id ?? "");
    if (!id) return;
    const p = store.patchPerson(id, payload as Partial<Person>);
    if (p) publish("intent.persons.changed", { kind: "update", person: p });
  } else if (topic === "intent.persons.delete") {
    const id = String(payload.id ?? "");
    if (!id) return;
    if (store.deletePerson(id)) publish("intent.persons.changed", { kind: "delete", person: { id } });
  }
}

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  await ensureBoot();
};

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;
  await ensureBoot();

  for (const msg of ctx.messages) {
    const meta = msg.metadata ?? {};
    if (msg.topic === "voice.transcript") {
      ingestVoiceTranscript(meta);
    } else if (msg.topic === "gaze.target.resolved") {
      ingestGazeEvent(meta);
    } else if (msg.topic.startsWith("intent.persons.")) {
      applyPersonCommand(msg.topic, meta);
    }
  }
  return Promise.resolve();
};

export const teardown: NodeTeardown = async () => {
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (server) { await server.close(); server = null; }
  if (store) { store.close(); store = null; }
  serverBoot = null;
  timeline = null;
  correlator = null;
  nodeId = null;
};

export default handler;
