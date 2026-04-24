import {
  createPerson,
  deletePerson,
  listGazeProfiles,
  listPersons,
  listVoiceProfiles,
  patchPerson,
} from "./api";
import type { GazeProfile, Person, VoiceProfile } from "./types";

export class PersonsPanel {
  private readonly host: HTMLElement;
  private persons: Person[] = [];
  private voices: VoiceProfile[] = [];
  private gazes: GazeProfile[] = [];
  private changedCb: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  onChanged(cb: () => void): void {
    this.changedCb = cb;
  }

  async refresh(): Promise<void> {
    const [persons, voices, gazes] = await Promise.all([
      listPersons(),
      listVoiceProfiles().catch(() => []),
      listGazeProfiles().catch(() => []),
    ]);
    this.persons = persons;
    this.voices = voices;
    this.gazes = gazes;
    // Skip the DOM swap while the user is mid-interaction inside this
    // panel — an open <select> dropdown lives in a separate native popup
    // layer but gets blown away the instant we clear innerHTML. This
    // makes linking a voice / face almost impossible on a periodic
    // re-render cadence.
    if (!this.host.contains(document.activeElement)) {
      this.render();
    }
    this.changedCb?.();
  }

  get all(): Person[] {
    return this.persons;
  }

  private render(): void {
    this.host.innerHTML = "";
    for (const p of this.persons) {
      this.host.appendChild(this.renderCard(p));
    }
    if (this.persons.length === 0) {
      const msg = document.createElement("div");
      msg.className = "hint";
      msg.textContent = "No persons yet. Create one and link a voice or face profile.";
      this.host.appendChild(msg);
    }
  }

  private renderCard(p: Person): HTMLElement {
    const card = document.createElement("div");
    card.className = "person";
    card.style.setProperty("--c", p.color);

    const nameInput = document.createElement("input");
    nameInput.className = "person-name";
    nameInput.value = p.name;
    nameInput.onchange = async () => {
      await patchPerson(p.id, { name: nameInput.value.trim() || p.name });
      await this.refresh();
    };

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = p.color;

    const row1 = document.createElement("div");
    row1.className = "row";
    row1.append(swatch, nameInput);

    const voiceSel = this.buildSelect(
      this.voices.map((v) => ({ value: v.id, label: voiceLabel(v) })),
      p.voice_profile_id ?? "",
      "— no voice link —",
    );
    voiceSel.onchange = async () => {
      await patchPerson(p.id, { voice_profile_id: voiceSel.value });
      await this.refresh();
    };

    const gazeSel = this.buildSelect(
      this.gazes.map((g) => ({ value: g.id, label: gazeLabel(g) })),
      p.gaze_profile_id ?? "",
      "— no face link —",
    );
    gazeSel.onchange = async () => {
      await patchPerson(p.id, { gaze_profile_id: gazeSel.value });
      await this.refresh();
    };

    const row2 = document.createElement("div");
    row2.className = "row";
    const vLab = document.createElement("label");
    vLab.textContent = "voice";
    vLab.appendChild(voiceSel);
    const gLab = document.createElement("label");
    gLab.textContent = "face";
    gLab.appendChild(gazeSel);
    row2.append(vLab, gLab);

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "delete";
    del.onclick = async () => {
      if (!confirm(`Delete ${p.name}?`)) return;
      await deletePerson(p.id);
      await this.refresh();
    };

    card.append(row1, row2, del);
    return card;
  }

  private buildSelect(
    options: { value: string; label: string }[],
    current: string,
    emptyLabel: string,
  ): HTMLSelectElement {
    const sel = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = emptyLabel;
    sel.appendChild(blank);
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === current) opt.selected = true;
      sel.appendChild(opt);
    }
    return sel;
  }

  async promptCreate(): Promise<void> {
    const name = prompt("Person name?");
    if (!name) return;
    await createPerson({ name });
    await this.refresh();
  }
}

function voiceLabel(v: VoiceProfile): string {
  return `${v.name} (${v.id.slice(0, 8)})`;
}
function gazeLabel(g: GazeProfile): string {
  return `${g.name} (${g.id.slice(0, 8)})`;
}
