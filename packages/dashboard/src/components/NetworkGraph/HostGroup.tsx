import type { NodeProps } from "@xyflow/react";

/**
 * Visual "host" group — a labelled container that holds every node
 * physically hosted on the same machine.
 *
 * Three flavours, derived from `kind`:
 *   - "local"        — this brAIn process (always present)
 *   - "active-agent" — a remote brain-agent announcing >= 1 installable type
 *   - "passive"      — a remote bus client with no installable types
 *                       (brAIn-mobile, raw NATS publisher, …); its container
 *                       is rendered as an empty card.
 *
 * Children are React Flow nodes whose `parentId` points at this group;
 * combined with `extent: "parent"` on each child, they can't be dragged
 * outside the container.
 */

export type HostKind = "local" | "active-agent" | "passive";

export interface HostGroupData extends Record<string, unknown> {
  kind: HostKind;
  label: string;       // display name (host hostname, "Local", …)
  sublabel?: string;   // agent_id short / OS / etc.
  icon: string;        // emoji glyph rendered in the header
  isEmpty: boolean;    // no hosted children
}

const ACCENT_BY_KIND: Record<HostKind, string> = {
  "local": "var(--color-border)",
  "active-agent": "var(--color-accent)",
  "passive": "#a855f7",  // violet — matches dynamic edges
};

export function HostGroup({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as HostGroupData;
  const accent = ACCENT_BY_KIND[d.kind];
  return (
    <div
      className="w-full h-full rounded-lg border-2 border-dashed bg-surface/30 backdrop-blur-[2px] flex flex-col"
      style={{ borderColor: accent }}
    >
      {/* Header — non-interactive, lives at the top of the container */}
      <div
        className="px-3 py-1.5 flex items-center gap-2 text-text-muted text-[11px] border-b border-dashed shrink-0"
        style={{ borderColor: accent }}
      >
        <span className="text-base leading-none">{d.icon}</span>
        <span className="font-semibold text-text">{d.label}</span>
        {d.sublabel && <span className="font-mono opacity-60">{d.sublabel}</span>}
      </div>
      {/* Empty state — only for passive hosts with no children */}
      {d.isEmpty && (
        <div className="flex-1 flex items-center justify-center text-[11px] text-text-muted italic px-3 text-center">
          {d.kind === "passive"
            ? "bus participant — publishes only, hosts no nodes"
            : "no nodes here yet"}
        </div>
      )}
    </div>
  );
}
