/**
 * Shared helpers for the LLM facade — extracted to keep `llm-facade.ts`
 * under the max-lines budget. These are pure / stateless and used by the
 * facade's `tool()` / `tools()` paths.
 */
import { jsonSchema } from "ai";
import Ajv, { type ValidateFunction } from "ajv";
import { logger } from "../logger";
import { parseTolerantJson } from "./json-repair";

/** Parse a CLI agent's `{ "tool": "...", "args": {...} }` reply into the
 *  same shape `ctx.llm.tools()` returns for a model. Pulls the first JSON
 *  object out of the text (CLIs sometimes wrap it in prose/fences) and
 *  validates the tool name. Returns null when nothing usable is found. */
export function parseToolChoice(
  text: string,
  toolNames: string[],
): { toolName: string; args: Record<string, unknown> } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = parseTolerantJson<{ tool?: string; args?: Record<string, unknown> }>(match[0]);
    if (obj.tool && toolNames.includes(obj.tool)) {
      return { toolName: obj.tool, args: obj.args ?? {} };
    }
  } catch { /* not valid JSON — fall through */ }
  return null;
}

// One ajv for all tool schemas; compiled validators cached per schema
// object (same pattern as the bus publish-validator).
const toolSchemaAjv = new Ajv({
  allErrors: true,
  strict: false,  // schemas come from user configs — tolerate unknown keywords
});
const toolValidatorCache = new WeakMap<object, ValidateFunction>();

/** Detect plain-JSON-Schema vs zod. Zod schemas expose `parse()`; JSON
 *  Schema is a plain object. ai-sdk's `tool()` accepts both but needs
 *  JSON schemas explicitly wrapped via `jsonSchema()` so its validator
 *  knows what to do.
 *
 *  CRITICAL: `jsonSchema(raw)` alone carries the schema to the provider
 *  but does NOT validate the model's args — ai-sdk only validates when a
 *  `validate` function is supplied (zod validates itself). Providers like
 *  Ollama ignore tool schemas entirely, so without this hook a small
 *  model can answer `{content: "…"}` to a `{key, value}` tool and the
 *  garbage flows straight onto the bus. We compile the JSON Schema with
 *  ajv so nonconforming args raise `InvalidToolInputError`, which the
 *  facade turns into a corrective retry. */
export function wrapInputSchema(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null
      && typeof (raw as { parse?: unknown }).parse === "function") {
    return raw; // already zod — validates itself
  }
  // No declared schema (legacy subscription rows) → accept any object;
  // don't invent constraints the node never stated.
  if (typeof raw !== "object" || raw === null) {
    return jsonSchema({ type: "object", additionalProperties: true });
  }
  const schema = raw as Record<string, unknown>;
  let validateFn = toolValidatorCache.get(schema);
  if (!validateFn) {
    try {
      validateFn = toolSchemaAjv.compile(schema);
      toolValidatorCache.set(schema, validateFn);
    } catch (err) {
      // A malformed schema in a node config shouldn't break the call —
      // surface it and fall back to the old cast-only behaviour.
      logger.warn({ err }, "[ctx.llm] tool inputSchema failed to compile — args will not be validated");
      return jsonSchema(schema as Parameters<typeof jsonSchema>[0]);
    }
  }
  const fn = validateFn;
  return jsonSchema(schema as Parameters<typeof jsonSchema>[0], {
    validate: (value) => {
      if (fn(value)) return { success: true, value: value as Record<string, unknown> };
      const detail = (fn.errors ?? [])
        .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`)
        .join("; ");
      return { success: false, error: new Error(detail || "arguments do not match the tool's inputSchema") };
    },
  });
}

/** Framework-injected escape hatch for `ctx.llm.tools()`.
 *
 *  Every LLM-driven handler that picks among several tools needs a
 *  canonical "nothing more to do" choice. Without it, `toolChoice:
 *  "required"` (the safe default on local models) forces the LLM to
 *  fabricate a noisy fake action on observation-only wakes. Exposing
 *  `stop` framework-side means every node gets the escape for free,
 *  with identical semantics across the network. Callers detect it via
 *  `picked.toolName === "stop"` and exit their step loop. */
export const STOP_TOOL = {
  description:
    "End this wake intentionally. Call this when no further action and no message to the user is needed for the messages you just received. " +
    "The framework will park your node; you'll be re-invoked on the next subscribed message. " +
    "Prefer `stop` over emitting an empty `respond` — a respond goes to the user.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/** Build the (system, messages) pair for one `tools()` attempt.
 *
 *  Try 0 ships the real prompt verbatim. Retries keep the WHOLE
 *  conversation (so the model still sees the user's actual request),
 *  append its previous prose as an assistant turn (so it sees its own
 *  slip), then a tight user-side correction. Two correction flavours:
 *  plain-text-instead-of-tool-call, and tool-called-with-args-that-
 *  failed-the-inputSchema (`lastInvalid` carries the ajv detail). */
export function buildToolsAttemptPrompt(opts: {
  attempt: number;
  system?: string;
  baseMessages: ChatMessage[];
  lastText: string;
  lastInvalid: string;
  toolNames: string[];
}): { system: string; messages: ChatMessage[] } {
  const base = opts.system ?? "";
  if (opts.attempt === 0) return { system: base, messages: opts.baseMessages };

  const system = `${base}\n\nIMPORTANT: respond to the user's latest message by calling EXACTLY ONE of the available tools. Never reply with plain text, never apologise, never acknowledge instructions — just call the appropriate tool.`.trim();
  const correction = opts.lastInvalid
    ? `Your last tool call was rejected — its arguments do not match the tool's schema: ${opts.lastInvalid}. ` +
      `Call the tool again with an arguments object that satisfies the schema EXACTLY: every required field present, ` +
      `correct types, no extra wrapper like {"content": …}. Output only the corrected tool call.`
    : `That reply was plain text, not a tool call. ` +
      `Do NOT apologise, do NOT say "understood" or "I will", do NOT explain. ` +
      `Now answer my previous request above by calling EXACTLY ONE of: ${opts.toolNames.join(", ")}. ` +
      `Output only the tool call.`;
  const messages: ChatMessage[] = [
    ...opts.baseMessages,
    ...(opts.lastText ? [{ role: "assistant" as const, content: opts.lastText }] : []),
    { role: "user" as const, content: correction },
  ];
  return { system, messages };
}

/** Warn loudly when a schema uses `oneOf` / `anyOf`. Local LLMs handle
 *  discriminated unions unreliably; for branching dispatch use
 *  `ctx.llm.tools({tools: {...}})` with one flat tool per branch. */
export function warnIfUnionSchema(schema: unknown, label: string): void {
  if (typeof schema !== "object" || schema === null) return;
  const s = schema as { oneOf?: unknown; anyOf?: unknown };
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
    logger.warn(
      { tool: label },
      `[ctx.llm] tool uses oneOf/anyOf in its inputSchema. ` +
      `Local LLMs (Gemma, smaller Llamas) handle discriminated unions ` +
      `unreliably — prefer ctx.llm.tools({tools: {...}}) with one flat ` +
      `tool per branch. See @brain/sdk LLMToolOptions JSDoc.`,
    );
  }
}
