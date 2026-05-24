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
  /** Broker role: `embedded` → this hub runs its own NATS (would-be host),
   *  `external` → it joined someone else's broker (client). Drives the
   *  host/client badge on the right of the header. Undefined for passive
   *  hosts or before the value lands on first paint. */
  brokerMode?: "embedded" | "external";
}

// Violet for self-identification — the user's own host stands out in
// any multi-host network view. Passive (phones, raw publishers) drops
// to a muted slate so violet stays unambiguously "me".
const ACCENT_BY_KIND: Record<HostKind, string> = {
  "local": "#a855f7",
  "active-agent": "var(--color-accent)",
  "passive": "#64748b",
};

export function HostGroup({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as HostGroupData;
  const accent = ACCENT_BY_KIND[d.kind];
  const isMe = d.kind === "local";
  return (
    // NOTE: do NOT add `backdrop-blur` here. On iOS Safari, backdrop-filter on
    // these large host containers re-rasterises everything behind them on every
    // pan/zoom — it reliably crashes the WebKit renderer (the whole page reloads
    // then "a problem repeatedly occurred"), especially in the merged peer view.
    // Confirmed by A/B: re-adding the blur crashes mobile, removing it fixes it.
    <div
      className="w-full h-full rounded-lg border-2 border-dashed bg-surface/30 flex flex-col"
      style={{
        borderColor: accent,
        // Subtle violet wash on the user's own host so it reads as
        // "yours" even before they spot the badge.
        backgroundColor: isMe ? "rgba(168, 85, 247, 0.04)" : undefined,
      }}
    >
      {/* Header — non-interactive, lives at the top of the container.
          Left cluster: icon · label · "me" · sublabel.
          Right cluster (ml-auto pushes it to the edge): role badge. */}
      <div
        className="px-3 py-1.5 flex items-center gap-2 text-text-muted text-[11px] border-b border-dashed shrink-0"
        style={{ borderColor: accent }}
      >
        <span className="text-base leading-none">{d.icon}</span>
        <span className="font-semibold text-text">{d.label}</span>
        {isMe && (
          <span
            className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider text-white"
            style={{ backgroundColor: "#a855f7" }}
          >
            me
          </span>
        )}
        {d.sublabel && <span className="font-mono opacity-60">{d.sublabel}</span>}
        {d.brokerMode && (
          <span
            className="ml-auto px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider text-white"
            // Emerald = runs its own broker (would-be host). Amber = joined
            // someone else's (client). Distinct from the violet "me" so
            // role and locality read independently.
            style={{ backgroundColor: d.brokerMode === "embedded" ? "#10b981" : "#f59e0b" }}
            title={d.brokerMode === "embedded"
              ? "Runs its own NATS broker — host"
              : "Joined another hub's broker — client"}
          >
            {d.brokerMode === "embedded" ? "host" : "client"}
          </span>
        )}
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
