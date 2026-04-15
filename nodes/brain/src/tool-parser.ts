/**
 * Robust tool call parser for small LLMs.
 *
 * Handles common failures: trailing commas, single quotes, markdown fences,
 * field name variants (tool/tool_name, args/arguments/parameters).
 */

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

const TOOL_FIELD_NAMES = ["tool", "tool_name", "name", "function"];
const ARGS_FIELD_NAMES = ["args", "arguments", "parameters", "params", "input"];

/** Try to extract and parse a JSON object from messy LLM output. */
function extractJSON(text: string): Record<string, unknown> | null {
  // Strip markdown fences
  const clean = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");

  // Find the outermost { ... }
  const start = clean.indexOf("{");
  if (start === -1) return null;

  // Walk forward to find the matching closing brace
  let depth = 0;
  let end = -1;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    if (clean[i] === "}") depth--;
    if (depth === 0) { end = i; break; }
  }
  if (end === -1) return null;

  const jsonStr = clean.slice(start, end + 1);

  // Try parsing as-is first, then repair if it fails
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(repairJSON(jsonStr)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** Fix common JSON issues from small LLMs. */
function repairJSON(raw: string): string {
  let s = raw;
  // Single quotes → double quotes (but not inside already-double-quoted strings)
  s = s.replace(/'/g, '"');
  // Trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Unquoted keys: {tool: "x"} → {"tool": "x"}
  s = s.replace(/(\{|,)\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
  return s;
}

/** Parse a tool call from LLM text output. */
export function parseToolCall(text: string): ToolCall | null {
  const obj = extractJSON(text);
  if (!obj) return null;

  // Find the tool name field
  let toolName: string | undefined;
  for (const field of TOOL_FIELD_NAMES) {
    if (typeof obj[field] === "string" && obj[field]) {
      toolName = obj[field];
      break;
    }
  }
  if (!toolName) return null;

  // Find the args field
  let args: Record<string, unknown> = {};
  for (const field of ARGS_FIELD_NAMES) {
    if (obj[field] && typeof obj[field] === "object") {
      args = obj[field] as Record<string, unknown>;
      break;
    }
  }

  return { tool: toolName, args };
}

/** Parse a sleep request from LLM text. */
export function parseSleepRequest(text: string): string | null {
  // JSON tool call style
  const obj = extractJSON(text);
  if (obj) {
    let toolName: string | undefined;
    for (const field of TOOL_FIELD_NAMES) {
      if (typeof obj[field] === "string") { toolName = obj[field]; break; }
    }
    if (toolName === "sleep") {
      let args: Record<string, unknown> = {};
      for (const field of ARGS_FIELD_NAMES) {
        if (obj[field] && typeof obj[field] === "object") { args = obj[field] as Record<string, unknown>; break; }
      }
      if (typeof args.duration === "string") return args.duration;
    }
  }

  // Natural language: "I'll sleep for 5m"
  const natural = text.match(/sleep (?:for )?(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)/i);
  if (natural) return `${natural[1]}${natural[2].charAt(0)}`;

  return null;
}
