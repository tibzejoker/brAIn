/**
 * Helpers for getting useful text out of an `ai-sdk` generateText result.
 *
 * The motivating issue: "reasoning" models (gemma4:e4b, o1, Claude
 * extended thinking…) sometimes hide the final answer in side
 * channels — `result.reasoning`, `result.steps[0].text`, the chain-of-
 * thought wrapped in `<think>…</think>` tags. Every brAIn node that
 * called the LLM directly grew its own copy of this extraction logic;
 * this module centralises it.
 */

/** Strip out chain-of-thought blocks. Both `<think>` and `<thinking>`
 *  flavours appear in the wild, occasionally nested or unclosed. */
export function stripReasoningTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    // Truncated open-only variants — the model ran out of tokens before
    // closing the tag. Drop everything from the open onwards.
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/<thinking>[\s\S]*$/gi, "")
    .trim();
}

/** Pulls the answer out of an `ai-sdk` `generateText` result no matter
 *  where the model decided to put it. Returns `null` if nothing usable
 *  came back — callers can then retry or fall back. */
export function extractReasoningText(result: unknown, opts?: { stripReasoning?: boolean }): string | null {
  const stripReasoning = opts?.stripReasoning ?? true;
  const r = result as Record<string, unknown>;
  let text: string | null = null;
  if (typeof r.text === "string" && r.text) {
    text = r.text;
  } else if (Array.isArray(r.steps) && r.steps.length > 0) {
    const s = r.steps[0] as Record<string, unknown>;
    if (typeof s.text === "string" && s.text) text = s.text;
  }
  if (!text && typeof r.reasoning === "string") text = r.reasoning;
  if (!text) return null;
  return stripReasoning ? stripReasoningTags(text) || null : text;
}
