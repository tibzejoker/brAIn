import { listProfiles, renameProfile } from "./api";
import type { Profile } from "./types";

export class SpeakersPanel {
  private readonly root: HTMLUListElement;
  private profiles = new Map<string, Profile>();

  constructor(root: HTMLUListElement) {
    this.root = root;
  }

  async refresh(): Promise<void> {
    const list = await listProfiles();
    this.profiles = new Map(list.map((p) => [p.id, p]));
    this.render();
  }

  upsert(profile: Pick<Profile, "id" | "name"> & Partial<Profile>): void {
    const existing = this.profiles.get(profile.id);
    const merged: Profile = {
      color: "#64748b",
      sample_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...existing,
      ...profile,
    };
    this.profiles.set(profile.id, merged);
    this.render();
  }

  bumpSampleCount(id: string): void {
    const p = this.profiles.get(id);
    if (!p) return;
    p.sample_count += 1;
    this.render();
  }

  getColor(id: string): string {
    return this.profiles.get(id)?.color ?? "#64748b";
  }

  private render(): void {
    const sorted = Array.from(this.profiles.values()).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    );
    this.root.innerHTML = "";
    for (const p of sorted) {
      const li = document.createElement("li");
      li.className = "speaker";

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = p.color;

      const input = document.createElement("input");
      input.value = p.name;
      input.addEventListener("change", async () => {
        if (input.value && input.value !== p.name) {
          try {
            const updated = await renameProfile(p.id, input.value);
            this.upsert(updated);
          } catch {
            input.value = p.name;
          }
        }
      });

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${p.sample_count}`;

      li.append(swatch, input, count);
      this.root.appendChild(li);
    }
  }
}
