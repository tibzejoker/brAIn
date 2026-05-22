/**
 * Shared helpers for the LLM facade — extracted to keep `llm-facade.ts`
 * under the max-lines budget. These are pure / stateless and used by the
 * facade's `tool()` / `tools()` paths.
 */
import { jsonSchema } from "ai";
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

/** Detect plain-JSON-Schema vs zod. Zod schemas expose `parse()`; JSON
 *  Schema is a plain object. ai-sdk's `tool()` accepts both but needs
 *  JSON schemas explicitly wrapped via `jsonSchema()` so its validator
 *  knows what to do. */
export function wrapInputSchema(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null
      && typeof (raw as { parse?: unknown }).parse === "function") {
    return raw; // already zod
  }
  return jsonSchema(raw as Parameters<typeof jsonSchema>[0]);
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
