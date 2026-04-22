import { DataSet, Timeline as VisTimeline } from "vis-timeline/standalone";
import "vis-timeline/styles/vis-timeline-graph2d.css";

import type { SegmentEvent } from "./types";

type Item = {
  id: string;
  group: string;
  start: number;
  end: number;
  content: string;
  title: string;
  style: string;
};

type Group = {
  id: string;
  content: string;
};

const ITEM_TEMPLATE = (text: string) =>
  `<div class="seg-text">${escapeHtml(text)}</div>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export class Timeline {
  private readonly container: HTMLElement;
  private readonly items = new DataSet<Item>([]);
  private readonly groups = new DataSet<Group>([]);
  private readonly startedAt: number;
  private readonly timeline: VisTimeline;
  private resolveColor: (id: string) => string = () => "#64748b";
  private nextSeqId = 0;

  constructor(container: HTMLElement, startedAt: number) {
    this.container = container;
    this.startedAt = startedAt;
    this.timeline = new VisTimeline(container, this.items, this.groups, {
      stack: false,
      zoomMin: 1000,             // 1s minimum zoom
      zoomMax: 1000 * 60 * 60,   // 1h max zoom
      orientation: { axis: "top" },
      showCurrentTime: false,
      moveable: true,
      zoomable: true,
      selectable: true,
      tooltip: { followMouse: true, overflowMethod: "flip" },
      format: {
        minorLabels: {
          millisecond: "SSS",
          second: "ss",
          minute: "HH:mm",
          hour: "HH:mm",
        },
        majorLabels: {
          millisecond: "HH:mm:ss",
          second: "HH:mm",
          minute: "ddd D",
          hour: "ddd D",
        },
      },
      start: new Date(startedAt),
      end: new Date(startedAt + 60_000),
    });
  }

  setColorResolver(fn: (id: string) => string): void {
    this.resolveColor = fn;
    this.refreshGroupColors();
  }

  ensureGroup(speakerId: string, name: string): void {
    const existing = this.groups.get(speakerId);
    const color = this.resolveColor(speakerId);
    const content = `<span class="grp-dot" style="background:${color}"></span>${escapeHtml(name)}`;
    if (existing) {
      this.groups.update({ id: speakerId, content });
    } else {
      this.groups.add({ id: speakerId, content });
    }
  }

  add(event: SegmentEvent): void {
    this.ensureGroup(event.speaker_id, event.name);
    const color = this.resolveColor(event.speaker_id);
    const id = `seg_${this.nextSeqId++}_${event.t_start.toFixed(3)}`;
    this.items.add({
      id,
      group: event.speaker_id,
      start: this.startedAt + event.t_start * 1000,
      end: this.startedAt + event.t_end * 1000,
      content: ITEM_TEMPLATE(event.text),
      title: `${event.name} · ${fmtTs(event.t_start)}–${fmtTs(event.t_end)}\n${event.text}`,
      style: `background-color: ${color}33; border-color: ${color}; color: ${color};`,
    });
    this.scrollToEnd(event.t_end);
  }

  bulkLoad(events: SegmentEvent[]): void {
    for (const ev of events) this.add(ev);
    this.fit();
  }

  reset(): void {
    this.items.clear();
    this.groups.clear();
    this.timeline.setWindow(
      new Date(this.startedAt),
      new Date(this.startedAt + 60_000),
      { animation: false },
    );
  }

  fit(): void {
    this.timeline.fit({ animation: false });
  }

  /** Renames a group (when a profile is renamed). */
  renameGroup(speakerId: string, name: string): void {
    if (this.groups.get(speakerId)) {
      const color = this.resolveColor(speakerId);
      this.groups.update({
        id: speakerId,
        content: `<span class="grp-dot" style="background:${color}"></span>${escapeHtml(name)}`,
      });
    }
  }

  /** Removes a group and all its items (e.g. after merge). */
  removeGroup(speakerId: string): void {
    const itemIds = (this.items.get() as Item[])
      .filter((i) => i.group === speakerId)
      .map((i) => i.id);
    this.items.remove(itemIds);
    this.groups.remove(speakerId);
  }

  /** Re-parents all items from one group to another (used after a merge). */
  reparent(fromId: string, toId: string, toName: string, toColor: string): void {
    this.ensureGroup(toId, toName);
    const updates: Item[] = [];
    for (const item of this.items.get() as Item[]) {
      if (item.group === fromId) {
        updates.push({
          ...item,
          group: toId,
          style: `background-color: ${toColor}33; border-color: ${toColor}; color: ${toColor};`,
        });
      }
    }
    if (updates.length > 0) this.items.update(updates);
    this.groups.remove(fromId);
  }

  exportSegments(): SegmentEvent[] {
    return (this.items.get() as Item[]).map((i) => ({
      type: "segment",
      session_id: "",
      speaker_id: i.group,
      name: this.extractName(i.group),
      text: stripTags(i.content),
      t_start: (i.start - this.startedAt) / 1000,
      t_end: (i.end - this.startedAt) / 1000,
      provisional: false,
      confidence: 1,
    }));
  }

  private extractName(speakerId: string): string {
    const g = this.groups.get(speakerId);
    if (!g) return speakerId;
    return stripTags(g.content);
  }

  private refreshGroupColors(): void {
    for (const g of this.groups.get() as Group[]) {
      this.ensureGroup(g.id, stripTags(g.content));
    }
  }

  private scrollToEnd(tEndSeconds: number): void {
    const window = this.timeline.getWindow();
    const endMs = this.startedAt + tEndSeconds * 1000;
    if (endMs > window.end.getTime() - 2000) {
      const span = window.end.getTime() - window.start.getTime();
      this.timeline.setWindow(
        new Date(endMs - span + 5000),
        new Date(endMs + 5000),
        { animation: { duration: 200, easingFunction: "easeOutQuad" } },
      );
    }
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}
