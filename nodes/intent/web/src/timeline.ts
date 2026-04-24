import { getTimeline } from "./api";
import type { Person, TimelineGaze, TimelineSnapshot } from "./types";

const ROW_H = 48;
const PADDING = 12;
const LABEL_W = 110;
const VOICE_LANE_H = 16;
const GAZE_LANE_H = 14;
const LANE_GAP = 4;

// Max gap between consecutive gaze events before we consider the subject
// "offscreen" — anything longer renders as a neutral gray band rather
// than stretching the last committed state forever.
const OFFSCREEN_TIMEOUT_S = 2.0;

type Tip = {
  title: string;
  lines: string[];
  color?: string;
};

export class TimelineView {
  private readonly host: HTMLElement;
  private readonly tip: HTMLDivElement;
  private getPersons: () => Person[];
  private windowS = 60;

  constructor(host: HTMLElement, getPersons: () => Person[]) {
    this.host = host;
    this.getPersons = getPersons;
    this.tip = document.createElement("div");
    this.tip.className = "tl-tip";
    this.tip.style.display = "none";
    document.body.appendChild(this.tip);
  }

  async refresh(): Promise<void> {
    try {
      const snap = await getTimeline(this.windowS);
      this.render(snap);
    } catch (e) {
      console.warn("timeline refresh failed", e);
    }
  }

  private showTip(ev: MouseEvent, tip: Tip): void {
    const header = tip.color
      ? `<span class="sw" style="background:${tip.color}"></span>${escapeHtml(tip.title)}`
      : escapeHtml(tip.title);
    const body = tip.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
    this.tip.innerHTML = `<div class="hd">${header}</div>${body}`;
    this.tip.style.display = "block";
    this.moveTip(ev);
  }
  private moveTip(ev: MouseEvent): void {
    const pad = 12;
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    let x = ev.clientX + pad;
    let y = ev.clientY + pad;
    if (x + w > window.innerWidth) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight) y = ev.clientY - h - pad;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }
  private hideTip(): void {
    this.tip.style.display = "none";
  }

  private bindTip(el: SVGElement, tip: Tip): void {
    el.style.cursor = "help";
    el.addEventListener("mouseenter", (e) => this.showTip(e as MouseEvent, tip));
    el.addEventListener("mousemove", (e) => this.moveTip(e as MouseEvent));
    el.addEventListener("mouseleave", () => this.hideTip());
  }

  private render(snap: TimelineSnapshot): void {
    const persons = this.getPersons();
    if (persons.length === 0) {
      this.host.innerHTML =
        '<div class="hint">Link at least one person above to see a timeline.</div>';
      return;
    }

    const width = Math.max(600, this.host.clientWidth);
    const height = PADDING * 2 + persons.length * ROW_H;
    const plotW = width - LABEL_W - PADDING;

    const now = snap.now;
    const start = now - snap.window_s;
    const toX = (t: number) => LABEL_W + ((t - start) / snap.window_s) * plotW;
    const clampX = (xpx: number) => Math.max(LABEL_W, Math.min(LABEL_W + plotW, xpx));

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // Row backgrounds + labels
    persons.forEach((p, i) => {
      const y = PADDING + i * ROW_H;
      svg.appendChild(rect(LABEL_W, y, plotW, ROW_H - 4, "#1e293b"));
      svg.appendChild(text(8, y + ROW_H / 2 + 4, p.name, "#e2e8f0", 13));
      svg.appendChild(rect(0, y + 4, 6, ROW_H - 12, p.color));
    });

    // Build gaze intervals per person by walking events ordered by ts.
    const gazeByPerson = new Map<string, TimelineGaze[]>();
    for (const g of snap.gaze) {
      if (!g.source_person_id) continue;
      const list = gazeByPerson.get(g.source_person_id) ?? [];
      list.push(g);
      gazeByPerson.set(g.source_person_id, list);
    }
    for (const list of gazeByPerson.values()) {
      list.sort((a, b) => a.ts - b.ts);
    }

    // Gaze lane = continuous coloured band per interval. Lane sits below
    // the voice bar lane so you can see "speaking" and "gazing" at once.
    // If the gap between two events exceeds OFFSCREEN_TIMEOUT_S the
    // "tail" of that interval is rendered as an offscreen band — without
    // this, a state committed before the person left the frame would
    // stretch all the way to `now` and look like they were still there.
    persons.forEach((p, i) => {
      const events = gazeByPerson.get(p.id) ?? [];
      if (events.length === 0) return;
      const yGaze = PADDING + i * ROW_H + VOICE_LANE_H + LANE_GAP;

      for (let k = 0; k < events.length; k++) {
        const ev = events[k];
        const end = k + 1 < events.length ? events[k + 1].ts : now;
        const activeEnd = Math.min(end, ev.ts + OFFSCREEN_TIMEOUT_S);

        // "committed state" slice — the event's actual target
        const aX0 = clampX(toX(ev.ts));
        const aX1 = clampX(toX(activeEnd));
        if (aX1 - aX0 >= 1) {
          const fill = gazeColor(ev, p.color);
          const band = rect(aX0, yGaze, aX1 - aX0, GAZE_LANE_H, fill);
          band.setAttribute("opacity", ev.target_kind === "unknown" ? "0.3" : "0.75");
          this.bindTip(band, gazeTip(ev, persons, now));
          svg.appendChild(band);

          if (ev.target_kind === "profile" && ev.target_person_id) {
            const tgtIdx = persons.findIndex((q) => q.id === ev.target_person_id);
            if (tgtIdx >= 0 && tgtIdx !== i) {
              const yFrom = yGaze + GAZE_LANE_H / 2;
              const yTo = PADDING + tgtIdx * ROW_H + ROW_H / 2;
              const xmid = (aX0 + aX1) / 2;
              const arrow = document.createElementNS("http://www.w3.org/2000/svg", "line");
              arrow.setAttribute("x1", String(xmid));
              arrow.setAttribute("y1", String(yFrom));
              arrow.setAttribute("x2", String(xmid));
              arrow.setAttribute("y2", String(yTo));
              arrow.setAttribute("stroke", p.color);
              arrow.setAttribute("stroke-width", "1");
              arrow.setAttribute("opacity", "0.5");
              svg.appendChild(arrow);
            }
          }
        }

        // "offscreen" slice — when the gap exceeded the timeout. For
        // the last event's tail, we extend to `now` so the end of the
        // plot shows "currently offscreen" when applicable.
        if (end > activeEnd) {
          const oX0 = clampX(toX(activeEnd));
          const oX1 = clampX(toX(end));
          if (oX1 - oX0 >= 1) {
            const gap = rect(oX0, yGaze, oX1 - oX0, GAZE_LANE_H, "#1e293b");
            gap.setAttribute("stroke", "#475569");
            gap.setAttribute("stroke-width", "0.5");
            gap.setAttribute("stroke-dasharray", "2 2");
            gap.setAttribute("opacity", "0.6");
            this.bindTip(gap, {
              title: `${p.name} — offscreen`,
              color: "#64748b",
              lines: [
                `no face detected for ${(end - activeEnd).toFixed(1)}s`,
                `(last seen looking at ${summarizeGaze(ev, persons)})`,
              ],
            });
            svg.appendChild(gap);
          }
        }
      }
    });

    // Voice bars (top lane of each row). Position uses ts_end (wall-clock
    // when VAD detected speech_end, captured before STT runs) so the bar
    // lands where the user actually spoke, not where the pipeline
    // finished. Falls back to ts (delivery time) only if the voice
    // engine didn't emit ts_end for backwards compat.
    for (const v of snap.voice) {
      if (!v.person_id) continue;
      const idx = persons.findIndex((p) => p.id === v.person_id);
      if (idx < 0) continue;
      const p = persons[idx];
      const yVoice = PADDING + idx * ROW_H + 4;
      const duration = Math.max(0.1, v.t_end - v.t_start);
      const bar_end = v.ts_end ?? v.ts;
      const bar_start = bar_end - duration;
      const x0 = clampX(toX(bar_start));
      const x1 = clampX(toX(bar_end));
      if (x1 < LABEL_W + 1) continue;
      const bar = rect(x0, yVoice, Math.max(2, x1 - x0), VOICE_LANE_H - 4, p.color);
      bar.setAttribute("opacity", v.provisional ? "0.4" : "0.95");
      bar.setAttribute("stroke", "#0f172a");
      bar.setAttribute("stroke-width", "0.5");
      this.bindTip(bar, {
        title: `${p.name} · spoke ${duration.toFixed(1)}s${v.provisional ? " (partial)" : ""}`,
        color: p.color,
        lines: [
          v.text || "(no transcript)",
          `session t=${v.t_start.toFixed(1)}–${v.t_end.toFixed(1)}s`,
        ],
      });
      svg.appendChild(bar);
    }

    // Legend for the gaze lane colours
    const lg = svg.appendChild(_textEl(LABEL_W, height - 2, "gaze:", "#64748b", 10));
    void lg;
    const legendItems: Array<[string, string]> = [
      ["camera", "#22d3ee"],
      ["another person", "#a855f7"],
      ["scene", "#64748b"],
      ["unknown", "#334155"],
    ];
    let legendX = LABEL_W + 40;
    for (const [label, col] of legendItems) {
      svg.appendChild(rect(legendX, height - 12, 10, 10, col));
      svg.appendChild(_textEl(legendX + 14, height - 2, label, "#94a3b8", 10));
      legendX += label.length * 6 + 28;
    }

    // "now" cursor
    const cursor = document.createElementNS("http://www.w3.org/2000/svg", "line");
    cursor.setAttribute("x1", String(LABEL_W + plotW));
    cursor.setAttribute("y1", "0");
    cursor.setAttribute("x2", String(LABEL_W + plotW));
    cursor.setAttribute("y2", String(height));
    cursor.setAttribute("stroke", "#94a3b8");
    cursor.setAttribute("stroke-dasharray", "3 3");
    svg.appendChild(cursor);

    this.host.innerHTML = "";
    this.host.appendChild(svg);
  }
}

function gazeColor(g: TimelineGaze, ownColor: string): string {
  if (g.target_kind === "camera") return "#22d3ee";
  if (g.target_kind === "profile") return g.target_person_id ? ownColor : "#a855f7";
  if (g.target_kind === "scene") return "#64748b";
  return "#334155";
}

function summarizeGaze(g: TimelineGaze, persons: Person[]): string {
  if (g.target_kind === "camera") return "the camera";
  if (g.target_kind === "profile" && g.target_person_id) {
    const tgt = persons.find((q) => q.id === g.target_person_id);
    return tgt ? tgt.name : "someone";
  }
  if (g.target_kind === "profile") return "an unlinked face";
  if (g.target_kind === "scene") return g.description ? `"${g.description}"` : "the scene";
  return g.target_kind;
}

function gazeTip(g: TimelineGaze, persons: Person[], now: number): Tip {
  const src = persons.find((p) => p.id === g.source_person_id);
  let targetLabel: string;
  if (g.target_kind === "camera") {
    targetLabel = "📷 the camera";
  } else if (g.target_kind === "profile" && g.target_person_id) {
    const tgt = persons.find((q) => q.id === g.target_person_id);
    targetLabel = tgt ? `${tgt.name}` : "another person";
  } else if (g.target_kind === "profile") {
    targetLabel = `unlinked face ${g.target_gaze_profile_id ?? ""}`.trim();
  } else if (g.target_kind === "scene") {
    targetLabel = g.description ? `scene — "${g.description}"` : "the scene";
  } else {
    targetLabel = g.target_kind;
  }
  const secsAgo = Math.round(now - g.ts);
  return {
    title: `${src?.name ?? "?"} → ${targetLabel}`,
    color: gazeColor(g, src?.color ?? "#64748b"),
    lines: [
      `${secsAgo}s ago`,
      g.gaze_x != null && g.gaze_y != null
        ? `gaze point: (${(g.gaze_x * 100).toFixed(0)}%, ${(g.gaze_y * 100).toFixed(0)}%)`
        : "",
    ].filter(Boolean),
  };
}

function rect(x: number, y: number, w: number, h: number, fill: string): SVGRectElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  el.setAttribute("fill", fill);
  return el;
}

function text(x: number, y: number, content: string, fill: string, size: number): SVGTextElement {
  return _textEl(x, y, content, fill, size);
}

function _textEl(x: number, y: number, content: string, fill: string, size: number): SVGTextElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("fill", fill);
  el.setAttribute("font-size", String(size));
  el.setAttribute("font-family", "ui-sans-serif, system-ui, sans-serif");
  el.textContent = content;
  return el;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}
