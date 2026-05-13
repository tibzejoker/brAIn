/**
 * Tolerant + repairing JSON parsers for LLM output.
 *
 * Models love to emit JSON with quirks strict parsers reject:
 *   - `+15` instead of `15` (leading plus)
 *   - single-quoted keys
 *   - trailing commas
 *
 * Worse, when `maxOutputTokens` is hit mid-stream, the JSON can be cut
 * off partway through a key or value — `{"happiness":-10,"` shows up
 * in the wild. `repairTruncatedJson` walks back to the last safe point
 * and balances braces so the caller still gets something usable.
 *
 * Promoted from brainpet (the only previous home of this logic) so any
 * node parsing model output JSON can reuse it.
 */

/** Strict-ish JSON parse with the three common LLM-style quirks
 *  normalised first. Throws like JSON.parse if the input is truly
 *  unrepairable. */
export function parseTolerantJson<T = Record<string, unknown>>(s: string): T {
  const normalised = s
    .replace(/:\s*\+(\d)/g, ": $1")                     // `+15` -> `15`
    .replace(/,\s*([}\]])/g, "$1")                      // trailing commas
    .replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3');  // single-quoted keys
  return JSON.parse(normalised) as T;
}

/** Best-effort repair for JSON cut off mid-write. Strips the trailing
 *  partial key/value to the last comma or `{`, balances unclosed
 *  braces, and tries to parse again. Returns `{}` if hopeless. */
export function repairTruncatedJson<T extends Record<string, unknown> = Record<string, unknown>>(s: string): T {
  let body = s.trim();
  try { return parseTolerantJson<T>(body); } catch { /* continue */ }
  // Walk back to the last `,` or `{` so we drop any half-written pair.
  const stripIdx = Math.max(body.lastIndexOf(","), body.lastIndexOf("{"));
  if (stripIdx > 0) body = body.slice(0, stripIdx);
  // Balance braces.
  const open = (body.match(/\{/g) ?? []).length;
  const close = (body.match(/\}/g) ?? []).length;
  body = body + "}".repeat(Math.max(0, open - close));
  try { return parseTolerantJson<T>(body); } catch { return {} as T; }
}
