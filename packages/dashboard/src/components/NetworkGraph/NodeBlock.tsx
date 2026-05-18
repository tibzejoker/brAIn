import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";

type NodeBlockData = Node<{
  label: string;
  nodeType: string;
  state: string;
  transport: string;
  targetAgentId?: string;
  tags: string[];
  hasUi: boolean;
  /** Open the UI in the fullscreen modal (separate route-style overlay). */
  onOpenUi?: () => void;
  /** Toggle in-graph in-place expansion. On desktop this grows the
   *  node and embeds the UI iframe right inside the card; on mobile
   *  the upstream handler routes straight to fullscreen instead so
   *  this callback is never invoked from the cramped node tile. */
  onToggleExpand?: () => void;
  /** Persist a new size after the user drags the NodeResizer handle.
   *  Stored upstream in NetworkGraph so collapsing then re-expanding
   *  restores the last size for THIS node. */
  onResizeExpanded?: (w: number, h: number) => void;
  /** True while this node is currently expanded (multiple nodes may
   *  be expanded at once — set membership is kept in NetworkGraph). */
  isExpanded: boolean;
  /** Optional persisted size from a previous drag. When omitted the
   *  card uses DEFAULT_EXPANDED_{W,H}. */
  expandedWidth?: number;
  expandedHeight?: number;
  subscribes: string[];
  publishes: string[];
  unreadCount: number;
  /** AuthorityLevel value (0=BASIC, 1=ELEVATED, 2=ROOT). */
  authorityLevel: number;
  /** When true, render the authority chip + top/bottom capability
   *  handles so authority edges can attach. Driven by the dashboard's
   *  capability-hover toggle, not by hover state. */
  showCapabilityLayer: boolean;
  /** Currently hovered? Drives the "controlled by / controls" labels
   *  around the top/bottom handles — only the hovered node renders
   *  them, to keep the graph quiet at rest. */
  isHovered: boolean;
}>;

// === Inline SVG icons ========================================================
// Kept inline to avoid pulling in an icon library just for these three
// 16x16 strokes. All three are tuned to read against the dark surface
// tokens and match the rest of the dashboard's subtle, monochrome
// chrome. `currentColor` so they pick up the surrounding text class.

function IconChevronDown(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function IconChevronUp(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
}

function IconFullscreen(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
    </svg>
  );
}

const AUTHORITY_CHIP: Record<number, { label: string; cls: string }> = {
  0: { label: "BASIC",     cls: "bg-slate-600 text-white" },
  1: { label: "ELEVATED",  cls: "bg-amber-600 text-white" },
  2: { label: "ROOT",      cls: "bg-red-700  text-white" },
};

// Match the stroke colours used in NetworkGraph.buildAuthorityEdges so
// the textual labels read as a direct legend for the lines.
const AUTH_CONTROL_COLOR = "#dc2626";
const AUTH_INSPECT_COLOR = "#0891b2";

const STATE_COLORS: Record<string, string> = {
  active: "border-node-active",
  sleeping: "border-node-sleeping",
  stopped: "border-node-stopped",
  terminated: "border-node-terminated",
};

const STATE_DOTS: Record<string, string> = {
  active: "bg-node-active",
  sleeping: "bg-node-sleeping",
  stopped: "bg-node-stopped",
  terminated: "bg-node-terminated",
};

// Layout constants — keeping these as fixed pixel values is what lets us
// position the Handle dots flush to their topic-row label without
// measuring the DOM at runtime. If you tweak the row spacing in the JSX
// below, update these too.
const HEADER_HEIGHT = 56;   // title row + meta pill row, in px
const IO_ROW_HEIGHT = 18;   // each input/output row, in px
/** Vertical centre (in px from the top of the node) for the i-th IO row. */
function ioRowTop(i: number): number {
  return HEADER_HEIGHT + i * IO_ROW_HEIGHT + IO_ROW_HEIGHT / 2;
}

/** Deterministic color from a string — same topic always gets the same hue */
function topicColor(topic: string): string {
  let hash = 0;
  for (let i = 0; i < topic.length; i++) {
    hash = topic.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

export function NodeBlock({ id, data, selected }: NodeProps<NodeBlockData>): React.ReactElement {
  const borderColor = STATE_COLORS[data.state] ?? "border-border";
  const dotColor = STATE_DOTS[data.state] ?? "bg-node-terminated";

  // Number of IO rows we need to render — one per input OR output,
  // whichever side has more. A row may have an input but no output (or
  // vice versa); the empty side is just a placeholder for alignment.
  const ioRowCount = Math.max(data.subscribes.length, data.publishes.length);

  // When expanded, the card grows to host the iframe. Default 480x360,
  // but the user can drag the NodeResizer handles on the right / bottom /
  // bottom-right corner to make it bigger (e.g. for the chat node UI)
  // or smaller. We keep the same border / surface tokens so the
  // expansion reads as "the same card, bigger" rather than a different
  // surface. The expanded shell is `flex flex-col` so the iframe area
  // can fill the remaining vertical space below the (unchanged) header
  // + IO rows.
  const DEFAULT_EXPANDED_W = 480;
  const DEFAULT_EXPANDED_H = 360;
  const expandedStyle = data.isExpanded
    ? {
        width: data.expandedWidth ?? DEFAULT_EXPANDED_W,
        height: data.expandedHeight ?? DEFAULT_EXPANDED_H,
      }
    : undefined;

  return (
    <div
      className={`
        relative rounded-lg border-2
        ${selected ? "bg-surface-overlay border-text" : `bg-surface-raised ${borderColor}`}
        ${data.isExpanded ? "flex flex-col" : "min-w-[260px]"} cursor-pointer transition-shadow hover:shadow-lg
      `}
      style={expandedStyle}
    >
      {/* NodeResizer — only active while expanded. React Flow renders
          drag handles on the chosen sides; we limit to right + bottom +
          bottom-right corner so they don't fight the chevron / fullscreen
          buttons at the top, and stay below sane min dimensions so the
          card never collapses to nothing. The size delta flows back to
          the parent via onResize so it persists across collapse/expand. */}
      {data.isExpanded && (
        <NodeResizer
          isVisible
          minWidth={320}
          minHeight={240}
          handleStyle={{ width: 8, height: 8, background: "var(--color-text-muted)", border: 0, borderRadius: 2 }}
          lineStyle={{ borderColor: "var(--color-border-bright)", borderWidth: 1 }}
          onResize={(_, p) => {
            (data.onResizeExpanded as ((w: number, h: number) => void) | undefined)?.(p.width, p.height);
          }}
        />
      )}
      {/* Unread badge */}
      {data.unreadCount > 0 && (
        <div className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1.5 rounded-full bg-node-stopped text-white text-[10px] font-bold flex items-center justify-center shadow-lg z-10">
          {data.unreadCount}
        </div>
      )}

      {/* Authority chip — only when the capability layer is toggled on. */}
      {data.showCapabilityLayer && (
        <div
          className={`absolute -top-2 -left-2 px-1.5 h-5 rounded text-[10px] font-bold flex items-center shadow-lg z-10 ${AUTHORITY_CHIP[data.authorityLevel].cls}`}
        >
          {AUTHORITY_CHIP[data.authorityLevel].label}
        </div>
      )}

      {/* Capability legend — stacked vertically, centred above and
          below the node. Handles are split (35% / 65%) so the actual
          lines don't collide, but the labels would overlap horizontally
          at that spacing so we keep them in a colour-coded column.
          All arrows point ↓ because the visual flow of every line
          descends: incoming descends INTO the node from above,
          outgoing descends AWAY beneath it. */}
      {data.showCapabilityLayer && data.isHovered && (
        <>
          {/* Top — incoming. ROOT never has "controlled by". */}
          <div className="absolute left-1/2 -translate-x-1/2 -top-12 flex flex-col items-center gap-0.5 text-[10px] font-bold whitespace-nowrap pointer-events-none leading-tight">
            {data.authorityLevel < 2 && (
              <span style={{ color: AUTH_CONTROL_COLOR }}>↓ can be controlled by</span>
            )}
            <span style={{ color: AUTH_INSPECT_COLOR }}>↓ can be inspected by</span>
          </div>
          {/* Bottom — outgoing. Only meaningful for ELEVATED+. */}
          {data.authorityLevel >= 1 && (
            <div className="absolute left-1/2 -translate-x-1/2 -bottom-12 flex flex-col items-center gap-0.5 text-[10px] font-bold whitespace-nowrap pointer-events-none leading-tight">
              <span style={{ color: AUTH_CONTROL_COLOR }}>↓ can control</span>
              <span style={{ color: AUTH_INSPECT_COLOR }}>↓ can inspect</span>
            </div>
          )}
        </>
      )}

      {/* === Header (centered) ===
          Fixed height matches HEADER_HEIGHT so handle positions line up.
          When the node carries a UI, two subtle outline icons sit at
          the top-right: a chevron that flips between expand (↓) and
          collapse (↑), plus a fullscreen square. Both use neutral
          text-muted colour to stay calm in the resting graph. */}
      <div className="px-3 pt-2 pb-1 flex items-center justify-center gap-2 relative">
        <span className={`w-2.5 h-2.5 rounded-full ${dotColor} shrink-0`} />
        <span className="font-semibold text-sm text-text truncate">{data.label}</span>
        {data.hasUi && (
          <div className="absolute top-1.5 right-2 flex items-center gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                (data.onToggleExpand as (() => void) | undefined)?.();
              }}
              title={data.isExpanded ? "Collapse" : "Expand UI in place"}
              className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-overlay transition-colors"
            >
              {data.isExpanded ? <IconChevronUp /> : <IconChevronDown />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                (data.onOpenUi as (() => void) | undefined)?.();
              }}
              title="Open UI fullscreen"
              className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-overlay transition-colors"
            >
              <IconFullscreen />
            </button>
          </div>
        )}
      </div>

      {/* Meta pills row (still in the header band) */}
      <div className="px-3 pb-2 flex items-center justify-center gap-1.5 text-[10px] text-text-muted">
        <span className="px-1.5 py-0.5 rounded bg-surface-overlay">{data.nodeType}</span>
        {data.transport === "remote" && (
          <span
            title={data.targetAgentId
              ? `hosted on remote agent "${data.targetAgentId}"`
              : "hosted on remote agent"}
            className="px-1.5 py-0.5 rounded bg-accent/15 text-accent flex items-center gap-1"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />remote
          </span>
        )}
        {data.transport === "web" && (
          <span
            title="external service over WebSocket"
            className="px-1.5 py-0.5 rounded bg-node-sleeping/15 text-node-sleeping"
          >
            web
          </span>
        )}
      </div>

      {/* === IO rows ===
          Each row is a 3-column grid: [input] [empty centre] [output].
          Empty cells keep the column widths stable so handles always
          touch the borders at the same x for every row. */}
      {ioRowCount > 0 && (
        <div className="pb-2">
          {Array.from({ length: ioRowCount }).map((_, i) => {
            const inputTopic = data.subscribes[i];
            const outputTopic = data.publishes[i];
            return (
              <div
                key={i}
                className="grid items-center px-3"
                style={{ height: `${IO_ROW_HEIGHT}px`, gridTemplateColumns: "1fr 8px 1fr" }}
              >
                {/* Left: input label */}
                <div className="flex items-center gap-1.5 min-w-0">
                  {inputTopic ? (
                    <>
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: topicColor(inputTopic) }}
                      />
                      <span className="text-[10px] text-text-muted truncate">{inputTopic}</span>
                    </>
                  ) : null}
                </div>
                {/* Centre spacer — keeps the two columns equal-width */}
                <div />
                {/* Right: output label */}
                <div className="flex items-center justify-end gap-1.5 min-w-0">
                  {outputTopic ? (
                    <>
                      <span className="text-[10px] text-text-muted truncate">{outputTopic}</span>
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ background: topicColor(outputTopic) }}
                      />
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* === Embedded UI (in-place expansion) ===
          When `isExpanded` is true the iframe takes over the bottom of
          the card. `flex-1` makes it claim the rest of the 360px shell
          below the (fixed-height) header + IO rows. `nodrag`/`nowheel`
          are React Flow data attributes that stop a drag started inside
          the iframe from yanking the node around the canvas or zooming
          the viewport — the embedded UI handles its own scroll. */}
      {data.isExpanded && data.hasUi && (
        <div className="flex-1 mx-2 mb-2 rounded border border-border bg-surface overflow-hidden">
          <iframe
            src={`/nodes/${id}/ui/`}
            title={`${data.label} UI`}
            className="nodrag nowheel"
            style={{ width: "100%", height: "100%", border: 0, display: "block" }}
          />
        </div>
      )}

      {/* === ReactFlow Handles ===
          One target handle on the left border per subscription, one
          source handle on the right border per publish topic. Each one
          is positioned with `top: <ioRowTop(i)>px` so its dot sits at
          the exact vertical centre of its label row. */}
      {data.subscribes.map((topic, i) => (
        <Handle
          key={`in-${topic}`}
          type="target"
          position={Position.Left}
          id={`in-${topic}`}
          style={{ top: `${ioRowTop(i)}px`, background: topicColor(topic) }}
          className="!w-2.5 !h-2.5 !border-0"
        />
      ))}
      {data.subscribes.length === 0 && (
        <Handle type="target" position={Position.Left} id="in-default" className="opacity-0" />
      )}

      {data.publishes.map((topic, i) => (
        <Handle
          key={`out-${topic}`}
          type="source"
          position={Position.Right}
          id={`out-${topic}`}
          style={{ top: `${ioRowTop(i)}px`, background: topicColor(topic) }}
          className="!w-2.5 !h-2.5 !border-0"
        />
      ))}
      {data.publishes.length === 0 && (
        <Handle type="source" position={Position.Right} id="out-default" className="opacity-0" />
      )}

      {/* Authority handles — 4 anchors so red (control) and cyan
          (inspect) don't sit on top of each other when both relations
          exist with the same peer. Layout: control left (35%),
          inspect right (65%), top = incoming, bottom = outgoing. */}
      {data.showCapabilityLayer && (
        <>
          <Handle type="target" position={Position.Top}    id="auth-in-control"   className="opacity-0" style={{ left: "35%" }} />
          <Handle type="target" position={Position.Top}    id="auth-in-inspect"   className="opacity-0" style={{ left: "65%" }} />
          <Handle type="source" position={Position.Bottom} id="auth-out-control"  className="opacity-0" style={{ left: "35%" }} />
          <Handle type="source" position={Position.Bottom} id="auth-out-inspect"  className="opacity-0" style={{ left: "65%" }} />
        </>
      )}
    </div>
  );
}
