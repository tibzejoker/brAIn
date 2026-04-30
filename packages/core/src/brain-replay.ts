/**
 * Trace replay helper.
 *
 * Re-publishes every message of a past trace as fresh emissions so a
 * scenario can be reproduced without manually re-driving the system.
 * Each new emission gets a brand-new id / timestamp; the causal
 * `parent_id` chain is rewritten through an id map so the new
 * messages share a fresh `trace_id` with the same shape as the
 * original. `metadata.replayed_from` points back at the source id
 * for traceability; `metadata.replayed_trace` carries the old trace.
 *
 * The bus history is a sliding window (10k by default) — traces
 * older than that simply return an empty chain, and the caller
 * 404s.
 */
import type { IBusService } from "./bus";

export async function replayTrace(
  bus: IBusService,
  traceId: string,
  opts: { intervalMs?: number } = {},
): Promise<{ replayed: number; new_trace_id: string | null }> {
  const original = bus.getTrace(traceId);
  if (original.length === 0) return { replayed: 0, new_trace_id: null };

  const idMap = new Map<string, string>();
  let newRoot: string | null = null;
  for (const m of original) {
    const newParent = m.parent_id ? idMap.get(m.parent_id) : undefined;
    const fresh = bus.publish({
      from: m.from,
      topic: m.topic,
      type: m.type,
      criticality: m.criticality,
      payload: m.payload,
      parent_id: newParent,
      metadata: { ...m.metadata, replayed_from: m.id, replayed_trace: traceId },
    });
    idMap.set(m.id, fresh.id);
    if (!newRoot && fresh.trace_id) newRoot = fresh.trace_id;
    if (opts.intervalMs && opts.intervalMs > 0) {
      await new Promise((r) => { setTimeout(r, opts.intervalMs); });
    }
  }
  return { replayed: original.length, new_trace_id: newRoot };
}
