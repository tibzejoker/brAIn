import {
  deleteFaceprint,
  deleteProfile,
  extractFaceprint,
  listFaceprints,
  listProfiles,
  mergeProfiles,
  recolorProfile,
  renameProfile,
} from "./api";
import type { Faceprint, Profile } from "./types";

export class FacesPanel {
  private readonly root: HTMLUListElement;
  private profiles = new Map<string, Profile>();
  private mergeSource: string | null = null;
  private expanded = new Set<string>();
  private fpCache = new Map<string, Faceprint[]>();
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
    this.fpCache.clear();
    this.render();
  }

  upsertLive(
    detected: { profile_id: string | null; name: string | null; color: string | null }[],
  ): void {
    let mutated = false;
    for (const d of detected) {
      if (!d.profile_id) continue;
      const existing = this.profiles.get(d.profile_id);
      if (!existing) {
        this.profiles.set(d.profile_id, {
          id: d.profile_id,
          name: d.name ?? d.profile_id,
          color: d.color ?? "#f59e0b",
          sample_count: 1,
          faceprint_count: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        mutated = true;
      }
    }
    if (mutated) this.render();
  }

  getColor(id: string | null): string | null {
    if (!id) return null;
    return this.profiles.get(id)?.color ?? null;
  }

  getName(id: string | null): string | null {
    if (!id) return null;
    return this.profiles.get(id)?.name ?? null;
  }

  onProfilesChanged(fn: () => void): void {
    this._profilesChanged = fn;
  }

  private _profilesChanged: (() => void) | null = null;

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
    if (!confirm(`Delete face "${p.name}"?`)) return;
    await deleteProfile(id);
    if (this.mergeSource === id) this.mergeSource = null;
    await this.refresh();
  }

  private async toggleExpand(id: string): Promise<void> {
    if (this.expanded.has(id)) {
      this.expanded.delete(id);
    } else {
      this.expanded.add(id);
      if (!this.fpCache.has(id)) {
        try {
          const fps = await listFaceprints(id);
          this.fpCache.set(id, fps);
        } catch {
          this.fpCache.set(id, []);
        }
      }
    }
    this.render();
  }

  private async handleExtract(profileId: string, faceprintId: string): Promise<void> {
    if (!confirm("Extract this faceprint into a new profile?")) return;
    await extractFaceprint(faceprintId);
    this.expanded.delete(profileId);
    await this.refresh();
  }

  private async handleDeleteFp(profileId: string, faceprintId: string): Promise<void> {
    const p = this.profiles.get(profileId);
    if (!p) return;
    if (p.faceprint_count <= 1) {
      alert("Can't delete the only faceprint of a profile. Delete the profile instead.");
      return;
    }
    if (!confirm("Delete this faceprint? Future frames in this appearance mode will create a new profile.")) return;
    await deleteFaceprint(faceprintId);
    this.fpCache.delete(profileId);
    await this.refresh();
  }

  private render(): void {
    const sorted = Array.from(this.profiles.values()).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    );
    this.root.innerHTML = "";
    this._profilesChanged?.();
    const merging = this.mergeSource !== null;
    for (const p of sorted) {
      const li = document.createElement("li");
      li.className = "face";
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
          this.profiles.set(p.id, { ...p, ...updated });
          this.onColorChange?.(p.id, newColor);
          this.render();
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
            this.profiles.set(p.id, { ...p, ...updated });
            this.render();
          } catch {
            input.value = p.name;
          }
        }
      });

      const count = document.createElement("span");
      count.className = "count";
      const fpc = p.faceprint_count || 0;
      count.textContent = fpc > 1 ? `${p.sample_count}·${fpc}fp` : `${p.sample_count}`;
      count.title = fpc > 1
        ? `${p.sample_count} samples across ${fpc} faceprints (appearance modes)`
        : `${p.sample_count} samples`;

      const expandBtn = document.createElement("button");
      expandBtn.className = "icon expand";
      expandBtn.type = "button";
      expandBtn.title = "Manage faceprints";
      expandBtn.textContent = this.expanded.has(p.id) ? "▴" : "▾";
      expandBtn.disabled = fpc < 1;
      expandBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.toggleExpand(p.id);
      });

      const mergeBtn = document.createElement("button");
      mergeBtn.className = "icon merge";
      mergeBtn.type = "button";
      const srcName = this.mergeSource ? this.profiles.get(this.mergeSource)?.name : "";
      mergeBtn.title = merging
        ? p.id === this.mergeSource
          ? "Cancel merge"
          : `Merge "${srcName}" into "${p.name}"`
        : "Start merge from this face";
      mergeBtn.textContent = p.id === this.mergeSource ? "✕" : "⇢";
      mergeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.handleMergeClick(p.id);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "icon del";
      delBtn.type = "button";
      delBtn.title = "Delete face";
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
        const fps = this.fpCache.get(p.id) ?? [];
        const expandLi = document.createElement("li");
        expandLi.className = "fp-list";
        if (fps.length === 0) {
          expandLi.textContent = "no faceprints";
        } else {
          for (const fp of fps) {
            const row = document.createElement("div");
            row.className = "fp-row";

            const meta = document.createElement("span");
            meta.className = "fp-meta";
            const created = new Date(fp.created_at);
            const ts = `${created.getHours().toString().padStart(2, "0")}:${created.getMinutes().toString().padStart(2, "0")}`;
            meta.textContent = `fp ${fp.id.slice(3, 9)} · ${fp.sample_count} samples · ${ts}`;

            const extractBtn = document.createElement("button");
            extractBtn.className = "icon";
            extractBtn.type = "button";
            extractBtn.title = "Extract this faceprint into a new profile";
            extractBtn.textContent = "↗";
            extractBtn.addEventListener("click", () => void this.handleExtract(p.id, fp.id));

            const fpDelBtn = document.createElement("button");
            fpDelBtn.className = "icon del";
            fpDelBtn.type = "button";
            fpDelBtn.title = "Delete this faceprint";
            fpDelBtn.textContent = "🗑";
            fpDelBtn.addEventListener("click", () => void this.handleDeleteFp(p.id, fp.id));

            row.append(meta, extractBtn, fpDelBtn);
            expandLi.appendChild(row);
          }
        }
        this.root.appendChild(expandLi);
      }
    }

    if (merging) {
      const hint = document.createElement("li");
      hint.className = "merge-hint";
      const sourceName = this.mergeSource ? this.profiles.get(this.mergeSource)?.name ?? "?" : "?";
      hint.textContent = `Click target to merge "${sourceName}" into it (✕ to cancel)`;
      this.root.appendChild(hint);
    }
  }
}
