/**
 * Polls the standalone intent service at INTENT_URL/api/intents for
 * records we haven't seen yet and exposes them through a simple async
 * queue. The since_id cursor is advanced in-memory across handler
 * iterations — a restart drops unseen intents (acceptable: the intent
 * DB keeps them, and nothing else on the bus waits on them).
 */
import { logger } from "@brain/core";

const log = logger.child({ node: "attention.intent" });

export type IntentRecord = {
  id: number;
  ts: string;
  source_person_id: string | null;
  source_voice_profile_id: string | null;
  source_name: string | null;
  target_kind: "person" | "camera" | "scene" | "unknown";
  target_person_id: string | null;
  target_gaze_profile_id: string | null;
  target_name: string | null;
  text: string;
  t_start: number;
  t_end: number;
  confidence: number;
};

export class IntentClient {
  private readonly baseUrl: string;
  private cursor: number;

  constructor(baseUrl: string, cursor = 0) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.cursor = cursor;
  }

  get since(): number {
    return this.cursor;
  }

  setSince(id: number): void {
    this.cursor = Math.max(this.cursor, id);
  }

  /** Fetch every intent record newer than the current cursor (ascending). */
  async poll(limit = 100): Promise<IntentRecord[]> {
    const url = new URL(`${this.baseUrl}/api/intents`);
    url.searchParams.set("limit", String(limit));
    if (this.cursor > 0) url.searchParams.set("since_id", String(this.cursor));
    let rows: IntentRecord[];
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      rows = (await res.json()) as IntentRecord[];
    } catch (e) {
      log.debug({ err: (e as Error).message }, "intent poll failed");
      return [];
    }
    // /api/intents returns DESC by id; flip so the LLM sees chronological.
    rows.sort((a, b) => a.id - b.id);
    for (const r of rows) {
      if (r.id > this.cursor) this.cursor = r.id;
    }
    return rows;
  }
}
