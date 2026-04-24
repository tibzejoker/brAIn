import { getTimeline } from "./api";
import type { Person, TimelineSnapshot } from "./types";

const ROW_H = 36;
const PADDING = 12;
const LABEL_W = 110;
const GAZE_DOT_R = 5;

export class TimelineView {
  private readonly host: HTMLElement;
  private getPersons: () => Person[];
  private windowS = 60;

  constructor(host: HTMLElement, getPersons: () => Person[]) {
    this.host = host;
    this.getPersons = getPersons;
  }

  async refresh(): Promise<void> {
    try {
      const snap = await getTimeline(this.windowS);
      this.render(snap);
    } catch (e) {
      console.warn("timeline refresh failed", e);
    }
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
    const x = (t: number) => LABEL_W + ((t - start) / snap.window_s) * plotW;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    // Row backgrounds + labels
    persons.forEach((p, i) => {
      const y = PADDING + i * ROW_H;
      const row = rect(LABEL_W, y, plotW, ROW_H - 4, "#1e293b");
      svg.appendChild(row);
      svg.appendChild(text(8, y + ROW_H / 2 + 4, p.name, "#e2e8f0", 13));
      svg.appendChild(rect(0, y + 4, 6, ROW_H - 12, p.color));
    });

    // Voice bars
    for (const v of snap.voice) {
      if (!v.person_id) continue;
      const idx = persons.findIndex((p) => p.id === v.person_id);
      if (idx < 0) continue;
      const p = persons[idx];
      const y = PADDING + idx * ROW_H + 6;
      const duration = Math.max(0.1, v.t_end - v.t_start);
      const bar_ts_start = v.ts - duration;
      const x0 = x(bar_ts_start);
      const x1 = x(v.ts);
      if (x1 < LABEL_W) continue;
      const bar = rect(Math.max(LABEL_W, x0), y, Math.max(2, x1 - Math.max(LABEL_W, x0)), ROW_H - 16, p.color);
      bar.setAttribute("opacity", v.provisional ? "0.35" : "0.9");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = v.text;
      bar.appendChild(title);
      svg.appendChild(bar);
    }

    // Gaze dots + arrows
    for (const g of snap.gaze) {
      if (!g.source_person_id) continue;
      const srcIdx = persons.findIndex((p) => p.id === g.source_person_id);
      if (srcIdx < 0) continue;
      const p = persons[srcIdx];
      const xPos = x(g.ts);
      if (xPos < LABEL_W) continue;
      const yCenter = PADDING + srcIdx * ROW_H + (ROW_H - 4) / 2;

      if (g.target_person_id) {
        const tgtIdx = persons.findIndex((q) => q.id === g.target_person_id);
        if (tgtIdx >= 0) {
          const yT = PADDING + tgtIdx * ROW_H + (ROW_H - 4) / 2;
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", String(xPos));
          line.setAttribute("y1", String(yCenter));
          line.setAttribute("x2", String(xPos));
          line.setAttribute("y2", String(yT));
          line.setAttribute("stroke", p.color);
          line.setAttribute("stroke-width", "1.5");
          line.setAttribute("opacity", "0.6");
          svg.appendChild(line);
        }
      }

      const color = g.target_kind === "camera" ? "#22d3ee" : p.color;
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(xPos));
      dot.setAttribute("cy", String(yCenter));
      dot.setAttribute("r", String(GAZE_DOT_R));
      dot.setAttribute("fill", color);
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${g.target_kind}${g.description ? ": " + g.description : ""}`;
      dot.appendChild(title);
      svg.appendChild(dot);
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
  const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("fill", fill);
  el.setAttribute("font-size", String(size));
  el.setAttribute("font-family", "ui-sans-serif, system-ui, sans-serif");
  el.textContent = content;
  return el;
}
