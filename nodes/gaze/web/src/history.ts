import { clearEvents, listEvents } from "./api";
import type { FacesPanel } from "./faces";
import type { GazeEvent } from "./types";

export class HistoryPanel {
  private readonly root: HTMLOListElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly panel: FacesPanel;
  private events: GazeEvent[] = [];
  private lastId = 0;
  private readonly maxRows = 300;

  constructor(root: HTMLOListElement, clearBtn: HTMLButtonElement, panel: FacesPanel) {
    this.root = root;
    this.clearBtn = clearBtn;
    this.panel = panel;
    this.clearBtn.addEventListener("click", () => {
      if (!confirm("Clear gaze history?")) return;
      void this.clear();
    });
  }

  async bootstrap(): Promise<void> {
    try {
      const initial = await listEvents(undefined, this.maxRows);
      this.events = initial;
      if (initial.length > 0) this.lastId = initial[initial.length - 1].id;
      this.render();
    } catch (e) {
      console.error("history bootstrap failed", e);
    }
  }

  async poll(): Promise<void> {
    try {
      const fresh = await listEvents(this.lastId, this.maxRows);
      if (fresh.length === 0) return;
      this.events.push(...fresh);
      if (this.events.length > this.maxRows) {
        this.events = this.events.slice(-this.maxRows);
      }
      this.lastId = fresh[fresh.length - 1].id;
      this.render();
    } catch (e) {
      console.error("history poll failed", e);
    }
  }

  private async clear(): Promise<void> {
    await clearEvents();
    this.events = [];
    this.lastId = 0;
    this.render();
  }

  refresh(): void {
    // Re-render without re-fetching (e.g. after a profile rename).
    this.render();
  }

  private nameFor(id: string | null): { name: string; color: string } {
    if (!id) return { name: "(unknown)", color: "#64748b" };
    const c = this.panel.getColor(id) ?? "#64748b";
    const p = this.panel.getName(id) ?? id;
    return { name: p, color: c };
  }

  private render(): void {
    this.root.innerHTML = "";
    const recent = this.events.slice().reverse();
    for (const ev of recent) {
      const li = document.createElement("li");
      li.className = "event";

      const time = new Date(ev.ts);
      const hh = time.getHours().toString().padStart(2, "0");
      const mm = time.getMinutes().toString().padStart(2, "0");
      const ss = time.getSeconds().toString().padStart(2, "0");

      const ts = document.createElement("span");
      ts.className = "ev-ts";
      ts.textContent = `${hh}:${mm}:${ss}`;

      const src = this.nameFor(ev.source_profile_id);
      const source = document.createElement("span");
      source.className = "ev-who";
      source.textContent = src.name;
      source.style.color = src.color;

      const arrow = document.createElement("span");
      arrow.className = "ev-arrow";
      arrow.textContent = "→";

      const target = document.createElement("span");
      target.className = "ev-target";
      if (ev.target_type === "camera") {
        target.textContent = "📷 camera";
        target.style.color = "#22d3ee";
      } else if (ev.target_type === "profile") {
        const tgt = this.nameFor(ev.target_profile_id);
        target.textContent = tgt.name;
        target.style.color = tgt.color;
      } else {
        target.textContent = ev.description ?? "(scene)";
        target.style.color = "#94a3b8";
        target.style.fontStyle = "italic";
      }

      li.append(ts, source, arrow, target);
      this.root.appendChild(li);
    }
  }
}
