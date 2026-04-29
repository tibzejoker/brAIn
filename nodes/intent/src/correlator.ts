/**
 * Correlator — port of the legacy Python engine.
 *
 * On a finalized voice segment, look at every gaze event whose source is
 * the same person, compute the dominant target during the speech window
 * (with state-freshness + lag adjustments), record an intent in the store,
 * and call the broadcast callback so the UI / bus can react.
 */
import type { GazeEvent, Timeline, VoiceSegment } from "./timeline";
import type { IntentRecord, IntentStore } from "./store";

export interface CorrelatorConfig {
  pre_s: number;
  post_s: number;
  state_freshness_s: number; // age past which a state is considered stale
  state_lag_s: number;       // detection-pipeline delay shift
}

export const DEFAULT_CORRELATOR_CONFIG: CorrelatorConfig = {
  pre_s: 0.5,
  post_s: 0.5,
  state_freshness_s: 2.0,
  state_lag_s: 1.0,
};

type Key = string; // "person:<id>" | "face:<id>" | "camera" | "scene"

export class IntentCorrelator {
  constructor(
    private readonly store: IntentStore,
    private readonly timeline: Timeline,
    private readonly cfg: CorrelatorConfig,
    private readonly broadcast: (intent: IntentRecord) => void,
  ) {}

  onSegment(seg: VoiceSegment): void {
    if (!seg.person_id) return;

    const duration = Math.max(0, seg.t_end - seg.t_start);
    const ref = seg.ts_end ?? seg.ts;
    const segStart = ref - duration - this.cfg.pre_s;
    const segEnd = ref + this.cfg.post_s;

    const lookback = Math.max(this.timeline.retention_s, 120);
    const allEvents = this.timeline.gazeEventsFor(seg.person_id, ref - lookback, segEnd)
      .slice().sort((a, b) => a.ts - b.ts);

    const intervals = buildIntervals(allEvents, this.cfg.state_freshness_s, this.cfg.state_lag_s);

    const overlap = new Map<Key, number>();
    const winners = new Map<Key, GazeEvent>();
    for (const [ivStart, ivEnd, ev] of intervals) {
      const lo = Math.max(ivStart, segStart);
      const hi = Math.min(ivEnd, segEnd);
      if (hi <= lo) continue;
      const span = hi - lo;
      const key = keyForEvent(ev);
      if (!key) continue;
      overlap.set(key, (overlap.get(key) ?? 0) + span);
      winners.set(key, ev);
    }

    const segSpan = Math.max(1e-6, segEnd - segStart);
    let targetKind = "unknown";
    let targetPersonId: string | null = null;
    let targetGazePid: string | null = null;
    let targetName: string | null = null;
    let description: string | null = null;
    let confidence = 0;

    if (overlap.size > 0) {
      const [bestKey, bestScore] = [...overlap].reduce((acc, cur) => cur[1] > acc[1] ? cur : acc);
      confidence = bestScore / segSpan;
      const bestEv = winners.get(bestKey);
      if (!bestEv) return;
      const [kind, ref2] = bestKey.split(":", 2) as [string, string | undefined];
      if (kind === "person") {
        targetKind = "person";
        targetPersonId = ref2 ?? null;
        const person = targetPersonId ? this.store.getPerson(targetPersonId) : null;
        if (person) {
          targetName = person.name;
          targetGazePid = person.gaze_profile_id;
        }
      } else if (kind === "face") {
        targetKind = "person";
        targetGazePid = ref2 ?? null;
      } else if (kind === "camera") {
        targetKind = "camera";
      } else if (kind === "scene") {
        targetKind = "scene";
        description = bestEv.description;
      }
    }

    const source = this.store.getPerson(seg.person_id);
    const sourceName = source?.name ?? seg.voice_name;

    const speechTs = seg.ts_end !== null
      ? new Date(seg.ts_end * 1000).toISOString().replace(/\.\d+Z$/, "Z")
      : new Date().toISOString();

    const intent = this.store.recordIntent({
      ts: speechTs,
      source_person_id: seg.person_id,
      source_voice_profile_id: seg.voice_profile_id,
      source_name: sourceName,
      target_kind: targetKind,
      target_person_id: targetPersonId,
      target_gaze_profile_id: targetGazePid,
      target_name: targetKind === "person" ? targetName : (targetKind === "scene" ? description : null),
      text: seg.text,
      t_start: seg.t_start,
      t_end: seg.t_end,
      confidence,
    });

    this.broadcast(intent);
  }
}

function buildIntervals(
  events: readonly GazeEvent[],
  freshnessS: number,
  lagS: number,
): Array<[number, number, GazeEvent]> {
  const now = Date.now() / 1000;
  const out: Array<[number, number, GazeEvent]> = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const nextTs = i + 1 < events.length ? events[i + 1].ts : now;
    const start = ev.ts - lagS;
    const end = Math.min(nextTs - lagS, ev.ts + freshnessS);
    if (end <= start) continue;
    out.push([start, end, ev]);
  }
  return out;
}

function keyForEvent(ev: GazeEvent): Key | null {
  if (ev.target_kind === "profile") {
    if (ev.target_person_id) return `person:${ev.target_person_id}`;
    if (ev.target_gaze_profile_id) return `face:${ev.target_gaze_profile_id}`;
    return null;
  }
  if (ev.target_kind === "camera") return "camera";
  if (ev.target_kind === "scene") return "scene";
  return null;
}
