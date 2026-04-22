import type { DetectResponse, DetectedFace } from "./types";

export class Overlay {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear(): void {
    const { width, height } = this.canvas;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.restore();
  }

  draw(result: DetectResponse, displayWidth: number, displayHeight: number): void {
    this.clear();
    const ctx = this.ctx;
    const byIndex = new Map(result.faces.map((f) => [f.face_index, f]));
    const byProfile = new Map<string, DetectedFace>();
    for (const f of result.faces) if (f.profile_id) byProfile.set(f.profile_id, f);

    for (const face of result.faces) {
      const color = face.color ?? "#f59e0b";
      const x = face.bbox.x_min * displayWidth;
      const y = face.bbox.y_min * displayHeight;
      const w = (face.bbox.x_max - face.bbox.x_min) * displayWidth;
      const h = (face.bbox.y_max - face.bbox.y_min) * displayHeight;

      ctx.lineWidth = face.provisional ? 1.5 : 2.5;
      ctx.setLineDash(face.provisional ? [4, 4] : []);
      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      if (face.looking_at_camera) {
        // Bright cyan ring = "eye contact with the camera/viewer".
        ctx.strokeStyle = "#22d3ee";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, Math.max(w, h) * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }

      const label = face.name ?? `Face ${face.face_index}`;
      const conf = face.match_confidence > 0 ? ` ${(face.match_confidence * 100).toFixed(0)}%` : "";
      const eye = face.looking_at_camera ? " 👁" : "";
      const io = face.inout_score !== null
        ? ` io=${face.inout_score.toFixed(2)}`
        : "";
      const text = `${label}${conf}${face.provisional ? " ?" : ""}${eye}${io}`;
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      const metrics = ctx.measureText(text);
      const padX = 4;
      const padY = 3;
      const boxW = metrics.width + padX * 2;
      const boxH = 16;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - boxH, boxW, boxH);
      ctx.fillStyle = "#0f172a";
      ctx.fillText(text, x + padX, y - padY);

      const eyeX = face.eye_center
        ? face.eye_center.x * displayWidth
        : x + w / 2;
      const eyeY = face.eye_center
        ? face.eye_center.y * displayHeight
        : y + h * 0.4;

      if (face.gaze && !face.looking_at_camera) {
        const gx = face.gaze.x * displayWidth;
        const gy = face.gaze.y * displayHeight;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(eyeX, eyeY);
        ctx.lineTo(gx, gy);
        ctx.stroke();
        const angle = Math.atan2(gy - eyeY, gx - eyeX);
        const head = 9;
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx - head * Math.cos(angle - Math.PI / 6), gy - head * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(gx - head * Math.cos(angle + Math.PI / 6), gy - head * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(gx, gy, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#0f172a";
        ctx.lineWidth = 1;
        ctx.stroke();

        if (face.looking_at_description) {
          this._drawTextTag(face.looking_at_description, gx, gy + 10, color);
        }
      }

      if (face.looking_at) {
        const target =
          (face.looking_at.startsWith("face_") ? byProfile.get(face.looking_at) : undefined) ??
          (() => {
            const m = face.looking_at?.match(/^face_(\d+)$/);
            return m ? byIndex.get(parseInt(m[1], 10)) : undefined;
          })();
        if (target) {
          const tx = target.bbox.x_min * displayWidth;
          const ty = target.bbox.y_min * displayHeight;
          const tw = (target.bbox.x_max - target.bbox.x_min) * displayWidth;
          const th = (target.bbox.y_max - target.bbox.y_min) * displayHeight;
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(tx - 4, ty - 4, tw + 8, th + 8);
          ctx.setLineDash([]);
        }
      }
    }
  }

  private _drawTextTag(text: string, anchorX: number, anchorY: number, color: string): void {
    const ctx = this.ctx;
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    const metrics = ctx.measureText(text);
    const padX = 6;
    const padY = 4;
    const boxW = metrics.width + padX * 2;
    const boxH = 18;
    const x = Math.max(4, anchorX - boxW / 2);
    const y = anchorY + 8;
    ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, boxW, boxH, 4);
    else ctx.rect(x, y, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(text, x + padX, y + boxH - padY - 1);
  }
}
