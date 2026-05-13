/**
 * Publish-time JSON Schema validation (Phase 1 — log-only).
 *
 * When a node publishes a message, the framework cross-checks the
 * payload against every matching subscriber's declared `inputSchema`
 * and emits a `<topic>.error` event back into the bus if any of them
 * reject the payload. The original message is still delivered as
 * normal — Phase 2 will gate delivery on validation later.
 *
 * Architecture:
 *   - `validatePublish(msg, subscribers)` is pure: it just runs ajv
 *     against the provided schemas and returns the failures.
 *   - `runPublishValidation(bus, msg)` is the wiring helper called from
 *     both bus impls (`BusService`, `NatsBusService`). It looks up
 *     subscribers via `BrainService.current.instanceRegistry`, calls
 *     the validator, logs a warning, and publishes a single
 *     `<topic>.error` system message per failed subscriber.
 *
 * Anti-recursion: the `.error` messages we publish are themselves
 * routed and would normally re-trigger validation. We bail out early
 * when the topic ends with `.error` AND the `from` is our system id
 * (`system.bus.validator`) — this lets unrelated error topics still
 * be validated if a node legitimately declares a schema on one.
 */
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import {
  isPublicSubscription,
  type Message,
  type NodeInfo,
  type SubscriptionConfig,
} from "@brain/sdk";
import { logger } from "../logger";
import { matchTopic } from "./bus.matcher";
import type { IBusService } from "./bus.interface";

/** Pseudo-node id stamped on every emitted `<topic>.error` event. Used
 *  to detect and skip our own validator output to prevent recursion. */
export const VALIDATOR_FROM = "system.bus.validator";

export interface ValidationFailure {
  subscriber_node_id: string;
  topic: string;
  /** Human-readable ajv error strings, e.g. `"/foo must be string"`. */
  errors: string[];
  /** Schema the payload was checked against (echoed for debugging). */
  expected_schema: Record<string, unknown>;
}

export interface SubscriberSchemaRef {
  node_id: string;
  /** The subscription's declared topic pattern (may contain wildcards). */
  topic: string;
  /** Already narrowed to the public, schema-bearing variant. */
  inputSchema: Record<string, unknown>;
}

// A single ajv instance for the whole process; the compiled schemas
// are cached so repeated publishes of the same topic don't re-compile.
const ajv = new Ajv({
  allErrors: true,
  strict: false,  // schemas come from user configs — tolerate unknown keywords
});

const compiledCache = new WeakMap<Record<string, unknown>, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction {
  let fn = compiledCache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    compiledCache.set(schema, fn);
  }
  return fn;
}

function fmtError(e: ErrorObject): string {
  const path = e.instancePath || "(root)";
  return `${path} ${e.message ?? "is invalid"}`;
}

/**
 * Pure validator — given a message and the set of subscriber schemas
 * its topic matched, return one entry per subscriber whose schema
 * rejected the payload.
 */
export function validatePublish(
  msg: Pick<Message, "topic" | "payload">,
  subscribers: SubscriberSchemaRef[],
): ValidationFailure[] {
  if (subscribers.length === 0) return [];
  const failures: ValidationFailure[] = [];
  for (const sub of subscribers) {
    let validate: ValidateFunction;
    try {
      validate = compile(sub.inputSchema);
    } catch (err) {
      // A malformed schema in a node config shouldn't blow up the bus —
      // surface it once and skip this subscriber.
      logger.warn(
        { err, node_id: sub.node_id, topic: sub.topic },
        "publish-validator: skipping invalid inputSchema",
      );
      continue;
    }
    // The node's `inputSchema` describes the SEMANTIC arguments (e.g.
    // `{action: "start"}`), not the bus envelope. Text-style topics
    // wrap that JSON inside a `TextPayload.content` string — try to
    // unwrap it first, and fall back to validating the raw payload
    // when the content isn't a JSON string (e.g. structured payloads
    // that bypass the text envelope).
    const target = unwrapForValidation(msg.payload);
    if (validate(target)) continue;
    const errs = (validate.errors ?? []).map(fmtError);
    failures.push({
      subscriber_node_id: sub.node_id,
      topic: sub.topic,
      errors: errs.length > 0 ? errs : ["payload rejected"],
      expected_schema: sub.inputSchema,
    });
  }
  return failures;
}

/**
 * Gather every subscriber whose declared topic pattern matches
 * `publishedTopic` AND who has a non-internal `inputSchema`. Pulled
 * out so both bus impls share the same lookup logic.
 */
export function collectSchemaSubscribers(
  nodes: NodeInfo[],
  publishedTopic: string,
  publisherNodeId: string,
): SubscriberSchemaRef[] {
  const out: SubscriberSchemaRef[] = [];
  for (const node of nodes) {
    // anti-loop: a node never validates against its own subscriptions
    if (node.id === publisherNodeId) continue;
    const subs: SubscriptionConfig[] = node.subscriptions;
    for (const sub of subs) {
      if (!isPublicSubscription(sub)) continue;
      if (!matchTopic(sub.topic, publishedTopic)) continue;
      out.push({
        node_id: node.id,
        topic: sub.topic,
        inputSchema: sub.inputSchema,
      });
    }
  }
  return out;
}

/**
 * Cheap predicate to short-circuit validation on messages the validator
 * itself emits (anti-recursion) and on any malformed envelope.
 */
function isValidatorEcho(msg: Pick<Message, "topic" | "from">): boolean {
  return msg.from === VALIDATOR_FROM && msg.topic.endsWith(".error");
}

/**
 * Full wiring entry-point. Called from each bus impl right after the
 * message envelope is sealed (id + timestamp assigned) but BEFORE the
 * usual fanout — we don't gate delivery in Phase 1, so the order is
 * cosmetic, but it gives Phase 2 the right hook point already.
 *
 * The helper resolves subscribers via `BrainService.current?.instance
 * Registry` (singleton — see `brain.service.ts`). If that's unset
 * (e.g. unit tests using the in-memory bus directly with no
 * BrainService around), we silently no-op: the bus stays usable.
 */
export function runPublishValidation(bus: IBusService, msg: Message): void {
  if (isValidatorEcho(msg)) return;

  const brain = (globalThis as { __brainService?: { instanceRegistry?: { list: () => NodeInfo[] } } }).__brainService;
  const registry = brain?.instanceRegistry;
  if (!registry) return;

  const nodes = registry.list();
  if (nodes.length === 0) return;

  const subscribers = collectSchemaSubscribers(nodes, msg.topic, msg.from);
  if (subscribers.length === 0) return;  // cheap exit when no schemas apply

  const failures = validatePublish(msg, subscribers);
  if (failures.length === 0) return;

  for (const f of failures) {
    logger.warn(
      {
        from: msg.from,
        topic: msg.topic,
        subscriber: f.subscriber_node_id,
        errors: f.errors,
      },
      "publish-validator: payload failed subscriber schema (log-only)",
    );

    try {
      bus.publish({
        from: VALIDATOR_FROM,
        topic: `${msg.topic}.error`,
        type: "text",
        criticality: 2,
        payload: {
          content: JSON.stringify({
            offending_payload: msg.payload,
            errors: f.errors,
            expected_schema: f.expected_schema,
          }),
        },
        metadata: {
          originalFrom: msg.from,
          originalTopic: msg.topic,
          originalMessageId: msg.id,
          subscriberNodeId: f.subscriber_node_id,
          mode: "log-only",
        },
        trace_id: msg.trace_id,
        parent_id: msg.id,
      });
    } catch (err) {
      // Last-resort guard: emitting the error event must never throw
      // out of the publish path.
      logger.warn({ err }, "publish-validator: failed to emit .error event");
    }
  }
}

/** Resolve what to validate against a node's `inputSchema`. The schema
 *  describes the semantic args (e.g. `{action: "start"}`), but
 *  publishers wrap that JSON inside `TextPayload.content` for text-
 *  style bus messages. Unwrap when we recognise the shape; otherwise
 *  hand the raw payload back unchanged so structured-payload topics
 *  still validate sensibly. */
function unwrapForValidation(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as { content?: unknown };
  if (typeof p.content !== "string") return payload;
  const trimmed = p.content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return payload;
  try { return JSON.parse(trimmed); } catch { return payload; }
}
