import { clearIntents, listIntents, openIntentStream } from "./api";
import type { Intent, Person } from "./types";

export class IntentsFeed {
  private readonly host: HTMLElement;
  private readonly items: Intent[] = [];
  private maxShown = 50;
  private getPersons: () => Person[];

  constructor(host: HTMLElement, getPersons: () => Person[]) {
    this.host = host;
    this.getPersons = getPersons;
  }

  async start(): Promise<void> {
    const existing = await listIntents();
    this.items.push(...existing);
    this.render();
    openIntentStream((i) => {
      this.items.unshift(i);
      this.items.length = Math.min(this.items.length, this.maxShown);
      this.render();
    });
  }

  async clear(): Promise<void> {
    if (!confirm("Delete all recorded intents?")) return;
    await clearIntents();
    this.items.length = 0;
    this.render();
  }

  private render(): void {
    const persons = this.getPersons();
    const personById = new Map(persons.map((p) => [p.id, p]));
    this.host.innerHTML = "";
    for (const i of this.items.slice(0, this.maxShown)) {
      const row = document.createElement("div");
      row.className = "intent";
      const src = i.source_person_id ? personById.get(i.source_person_id) : undefined;
      if (src) row.style.setProperty("--c", src.color);

      const srcName = i.source_name ?? "?";
      let targetLabel: string;
      const tgt = i.target_person_id ? personById.get(i.target_person_id) : undefined;
      if (i.target_kind === "camera") {
        targetLabel = "📷 camera";
      } else if (i.target_kind === "person") {
        targetLabel = tgt ? tgt.name : (i.target_gaze_profile_id ?? "face");
      } else if (i.target_kind === "scene") {
        targetLabel = i.target_name ? `scene (${i.target_name})` : "scene";
      } else {
        targetLabel = "—";
      }

      const line = document.createElement("div");
      line.className = "line";
      line.innerHTML =
        `<span class="src">${escapeHtml(srcName)}</span>` +
        ` <span class="arrow">→</span> ` +
        `<span class="tgt">${escapeHtml(targetLabel)}</span>` +
        `<span class="conf"> · conf ${(i.confidence * 100).toFixed(0)}%</span>`;
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = i.text;
      row.append(line, text);
      this.host.appendChild(row);
    }
    if (this.items.length === 0) {
      this.host.innerHTML =
        '<div class="hint">Speak once a person is linked to a voice profile and a face profile. Intents will land here.</div>';
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}
