import type { NodeHandler } from "@brain/sdk";
import { logger } from "@brain/core";

import { IntentClient, type IntentRecord } from "./intent-client";
import { ensureServices } from "./services";

const log = logger.child({ node: "attention" });

// Module-level state — the node is a single long-running process, so we
// keep the intent client + "are services up" flag here instead of
// serialising them through ctx.state. This survives every handler
// invocation of the same node instance, while still getting rebuilt
// from scratch if the user kills + respawns the node.
const INTENT_URL = process.env.INTENT_URL ?? "http://127.0.0.1:8767";
const intentClient = new IntentClient(INTENT_URL);

let servicesReady: Promise<void> | null = null;
let processed = 0;
let lastIntents: IntentRecord[] = [];

/**
 * NodeHandler — runs as a thin bridge between the standalone intent
 * correlator and the brAIn bus.
 *
 * 1. First call boots the voice/gaze/intent services (idempotent — if
 *    something else already spawned them we just wait for health).
 * 2. Every call polls the intent service for rows newer than our
 *    cursor and forwards each to `intent.output` (raw event) and
 *    `brain.input` (so the consciousness receives every intent and
 *    its own LLM decides what to do with it).
 * 3. Handler asks to sleep for `ATTENTION_TICK_MS` (default 1.5s) so
 *    the framework re-wakes us even when no bus message landed.
 */
export const handler: NodeHandler = async (ctx) => {
  ctx.log("info", `handler invoked (messages=${ctx.messages.length}, servicesReady=${servicesReady ? "set" : "unset"})`);
  if (!servicesReady) {
    ctx.log("info", "first tick — bootstrapping voice / gaze / intent services");
    servicesReady = ensureServices().then(
      () => { ctx.log("info", "all sub-services healthy"); },
      (e) => {
        ctx.log("error", `service bootstrap failed: ${(e as Error).message}`);
        throw e;
      },
    );
  }
  try {
    await servicesReady;
  } catch (e) {
    ctx.log("error", `servicesReady rejected: ${(e as Error).message}`);
    // keep going — maybe some services ARE up and polling will still work
  }

  const tickMs = Number(process.env.ATTENTION_TICK_MS ?? "1500");
  const intents = await intentClient.poll();

  if (intents.length > 0) {
    ctx.log("info", `tick: ${intents.length} new intent(s) (cursor → #${intentClient.since})`);
  } else {
    ctx.log("debug", `tick: no new intents (cursor #${intentClient.since})`);
  }

  for (const intent of intents) {
    processed += 1;
    lastIntents.push(intent);
    if (lastIntents.length > 50) lastIntents = lastIntents.slice(-50);
    publishIntent(ctx, intent);
    log.info(
      {
        id: intent.id,
        src: intent.source_name,
        tgt: intent.target_kind,
        tgt_name: intent.target_name,
      },
      `forwarded intent "${intent.text.slice(0, 80)}"`,
    );
  }

  ctx.state.processed = processed;
  ctx.state.last_cursor = intentClient.since;
  ctx.state.last_intents = lastIntents.slice(-20);

  // Re-wake ourselves even in the absence of a bus message. Any message
  // that lands on our subscribed topics resets the budget and
  // interrupts the sleep, so we stay responsive.
  ctx.sleep([
    { type: "timer", value: `${tickMs}ms` },
    { type: "any" },
  ]);
};

function publishIntent(
  ctx: Parameters<NodeHandler>[0],
  intent: IntentRecord,
): void {
  const meta = {
    intent_id: intent.id,
    intent_ts: intent.ts,
    source: intent.source_name,
    target_kind: intent.target_kind,
    target: intent.target_name,
    confidence: intent.confidence,
    text: intent.text,
  };

  // Raw intent stream — fans out every finalised intent for any node
  // that wants chronology / speaker / gaze-target information without
  // any filtering.
  ctx.publish("intent.output", {
    type: "text",
    criticality: 3,
    payload: { content: intent.text },
    metadata: meta,
  });

  // Every intent also gets pushed into `brain.input` so the
  // consciousness sees the full speech stream. The brain's own LLM
  // decides whether and how to respond — attention stays dumb on
  // purpose so we don't double-gate with two LLMs.
  ctx.publish("brain.input", {
    type: "text",
    criticality: 2,
    payload: { content: intent.text },
    metadata: { ...meta, source_node: "attention" },
  });
}

export default handler;
