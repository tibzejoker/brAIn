import {
  deleteProfile,
  deleteVoiceprint,
  extractVoiceprint,
  listProfiles,
  listVoiceprints,
  mergeProfiles,
  recolorProfile,
  renameProfile,
  type Voiceprint,
} from "./api";
import type { Profile } from "./types";

export class SpeakersPanel {
  private readonly root: HTMLUListElement;
  private profiles = new Map<string, Profile>();
  private mergeSource: string | null = null;
  private expanded = new Set<string>();
  private vpCache = new Map<string, Voiceprint[]>();
  private onColorChange: ((id: string, color: string) => void) | null = null;

  constructor(root: HTMLUListElement) {
    this.root = root;
  }

  setColorChangeHandler(fn: (id: string, color: string) => void): void {
    this.onColorChange = fn;
  }

  async refresh(): Promise<void> {
    const list = await listProfiles();
    this.profiles = new Map(list.map((p) => [p.id, p]));
    if (this.mergeSource && !this.profiles.has(this.mergeSource)) {
      this.mergeSource = null;
    }
    this.vpCache.clear();
    this.render();
  }

  upsert(profile: Pick<Profile, "id" | "name"> & Partial<Profile>): void {
    const existing = this.profiles.get(profile.id);
    const merged: Profile = {
      color: "#64748b",
      sample_count: 0,
      voiceprint_count: 0,
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

  private async handleMergeClick(targetId: string): Promise<void> {
    if (!this.mergeSource) {
      this.mergeSource = targetId;
      this.render();
      return;
    }
    if (this.mergeSource === targetId) {
      this.mergeSource = null;
      this.render();
      return;
    }
    const source = this.mergeSource;
    this.mergeSource = null;
    try {
      await mergeProfiles(source, targetId);
    } finally {
      await this.refresh();
    }
  }

  private async handleDeleteClick(id: string): Promise<void> {
    const p = this.profiles.get(id);
    if (!p) return;
    if (!confirm(`Delete speaker "${p.name}"?`)) return;
    await deleteProfile(id);
    if (this.mergeSource === id) this.mergeSource = null;
    await this.refresh();
  }

  private async toggleExpand(id: string): Promise<void> {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
      if (!this.vpCache.has(id)) {
        try {
          const vps = await listVoiceprints(id);
          this.vpCache.set(id, vps);
        } catch {
          this.vpCache.set(id, []);
        }
      }
    }
    this.render();
  }

  private async handleExtract(profileId: string, voiceprintId: string): Promise<void> {
    if (!confirm("Extract this voiceprint into a new speaker profile?")) return;
    await extractVoiceprint(voiceprintId);
    this.expanded.delete(profileId);
    await this.refresh();
  }

  private async handleDeleteVp(profileId: string, voiceprintId: string): Promise<void> {
    const p = this.profiles.get(profileId);
    if (!p) return;
    if (p.voiceprint_count <= 1) {
      alert("Can't delete the only voiceprint of a profile. Delete the profile instead.");
      return;
    }
    if (!confirm("Delete this voiceprint? Future audio in this vocal mode will create a new profile.")) return;
    await deleteVoiceprint(voiceprintId);
    this.vpCache.delete(profileId);
    await this.refresh();
  }

  private render(): void {
    const sorted = Array.from(this.profiles.values()).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    );
    this.root.innerHTML = "";
    const merging = this.mergeSource !== null;
    for (const p of sorted) {
      const li = document.createElement("li");
      li.className = "speaker";
      if (merging && p.id === this.mergeSource) li.classList.add("merge-source");
      else if (merging) li.classList.add("merge-target");

      const swatch = document.createElement("input");
      swatch.type = "color";
      swatch.className = "swatch";
      swatch.value = p.color;
      swatch.title = "Click to change color";
      swatch.addEventListener("change", async () => {
        const newColor = swatch.value;
        if (newColor === p.color) return;
        try {
          const updated = await recolorProfile(p.id, newColor);
          this.upsert(updated);
          this.onColorChange?.(p.id, newColor);
        } catch {
          swatch.value = p.color;
        }
      });

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
      const vpc = p.voiceprint_count || 0;
      count.textContent = vpc > 1 ? `${p.sample_count}·${vpc}vp` : `${p.sample_count}`;
      count.title = vpc > 1
        ? `${p.sample_count} samples across ${vpc} voiceprints (vocal modes)`
        : `${p.sample_count} samples`;

      const expandBtn = document.createElement("button");
      expandBtn.className = "icon expand";
      expandBtn.type = "button";
      expandBtn.title = "Manage voiceprints";
      expandBtn.textContent = this.expanded.has(p.id) ? "▴" : "▾";
      expandBtn.disabled = vpc < 1;
      expandBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleExpand(p.id);
      });

      const mergeBtn = document.createElement("button");
      mergeBtn.className = "icon merge";
      mergeBtn.type = "button";
      mergeBtn.title = merging
        ? p.id === this.mergeSource
          ? "Cancel merge"
          : `Merge "${this.profiles.get(this.mergeSource!)?.name}" into "${p.name}"`
        : "Start merge from this speaker";
      mergeBtn.textContent = p.id === this.mergeSource ? "✕" : "⇢";
      mergeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.handleMergeClick(p.id);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "icon del";
      delBtn.type = "button";
      delBtn.title = "Delete speaker";
      delBtn.textContent = "🗑";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.handleDeleteClick(p.id);
      });

      li.append(swatch, input, count, expandBtn, mergeBtn, delBtn);

      if (merging && p.id !== this.mergeSource) {
        li.addEventListener("click", (e) => {
          if (e.target === input) return;
          void this.handleMergeClick(p.id);
        });
      }

      this.root.appendChild(li);

      if (this.expanded.has(p.id)) {
        const vps = this.vpCache.get(p.id) ?? [];
        const expandLi = document.createElement("li");
        expandLi.className = "vp-list";
        if (vps.length === 0) {
          expandLi.textContent = "no voiceprints";
        } else {
          for (const vp of vps) {
            const row = document.createElement("div");
            row.className = "vp-row";

            const meta = document.createElement("span");
            meta.className = "vp-meta";
            const created = new Date(vp.created_at);
            const ts = `${created.getHours().toString().padStart(2, "0")}:${created.getMinutes().toString().padStart(2, "0")}`;
            meta.textContent = `vp ${vp.id.slice(3, 9)} · ${vp.sample_count} samples · ${ts}`;

            const extractBtn = document.createElement("button");
            extractBtn.className = "icon";
            extractBtn.type = "button";
            extractBtn.title = "Extract this voiceprint into a new profile";
            extractBtn.textContent = "↗";
            extractBtn.addEventListener("click", () => void this.handleExtract(p.id, vp.id));

            const vpDelBtn = document.createElement("button");
            vpDelBtn.className = "icon del";
            vpDelBtn.type = "button";
            vpDelBtn.title = "Delete this voiceprint";
            vpDelBtn.textContent = "🗑";
            vpDelBtn.addEventListener("click", () => void this.handleDeleteVp(p.id, vp.id));

            row.append(meta, extractBtn, vpDelBtn);
            expandLi.appendChild(row);
          }
        }
        this.root.appendChild(expandLi);
      }
    }

    if (merging) {
      const hint = document.createElement("li");
      hint.className = "merge-hint";
      const sourceName = this.profiles.get(this.mergeSource!)?.name ?? "?";
      hint.textContent = `Click target to merge "${sourceName}" into it (✕ to cancel)`;
      this.root.appendChild(hint);
    }
  }
}
