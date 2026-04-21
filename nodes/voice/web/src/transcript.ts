import type { SegmentEvent } from "./types";

export class Transcript {
  private readonly root: HTMLOListElement;
  private readonly maxLines = 200;

  constructor(root: HTMLOListElement) {
    this.root = root;
  }

  add(event: SegmentEvent, color: string): void {
    const li = document.createElement("li");
    li.className = "line" + (event.provisional ? " provisional" : "");

    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = formatTs(event.t_start);

    const who = document.createElement("span");
    who.className = "who";
    who.style.color = color;
    who.textContent = event.name;

    const text = document.createElement("span");
    text.textContent = event.text;

    li.append(ts, who, text);
    this.root.appendChild(li);

    while (this.root.children.length > this.maxLines) {
      this.root.removeChild(this.root.firstChild!);
    }
    li.scrollIntoView({ block: "end" });
  }
}

function formatTs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
