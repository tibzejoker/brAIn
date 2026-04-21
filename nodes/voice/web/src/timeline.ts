import type { SegmentEvent } from "./types";

type Segment = {
  speakerId: string;
  color: string;
  tStart: number;
  tEnd: number;
};

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private segments: Segment[] = [];
  private windowSec = 60;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  add(event: SegmentEvent, color: string): void {
    this.segments.push({
      speakerId: event.speaker_id,
      color,
      tStart: event.t_start,
      tEnd: event.t_end,
    });
    this.render();
  }

  reset(): void {
    this.segments = [];
    this.render();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  private render(): void {
    const { ctx, canvas } = this;
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);

    const tMax = this.segments.length === 0
      ? this.windowSec
      : Math.max(this.windowSec, ...this.segments.map((s) => s.tEnd));
    const tMin = Math.max(0, tMax - this.windowSec);
    const span = tMax - tMin;

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, h);

    // Grid (10s)
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 1;
    for (let t = Math.ceil(tMin / 10) * 10; t <= tMax; t += 10) {
      const x = ((t - tMin) / span) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#475569";
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.fillText(`${t.toFixed(0)}s`, x + 4, h - 4);
    }

    // Lane per speaker
    const speakers = Array.from(new Set(this.segments.map((s) => s.speakerId)));
    const laneH = Math.max(12, (h - 20) / Math.max(1, speakers.length));

    for (const seg of this.segments) {
      if (seg.tEnd < tMin) continue;
      const lane = speakers.indexOf(seg.speakerId);
      const x = ((seg.tStart - tMin) / span) * w;
      const wpx = Math.max(2, ((seg.tEnd - seg.tStart) / span) * w);
      const y = 4 + lane * laneH;
      ctx.fillStyle = seg.color;
      ctx.fillRect(x, y, wpx, laneH - 4);
    }
  }
}
