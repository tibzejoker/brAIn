import { useRef } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import type { PortsConfig, PortBindings } from "@brain/sdk";

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
  /** 2-layer wiring — primary source for the IO column rendering.
   *  Every node carries these in modern snapshots (the framework
   *  auto-derives ports for legacy types at spawn). When absent we
   *  fall back to `subscribes` / `publishes` so peer-hub nodes on an
   *  older brAIn keep showing handles, just without the dashed boxes. */
  ports?: PortsConfig;
  portBindings?: PortBindings;
  /** Legacy flat lists — kept as the fallback path described above. */
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

// Layout constants — fixed pixel values so React Flow handles can be
// positioned by absolute offset without measuring the DOM. Each port
// block is: name row (20px) + dashed topic box ((maxTopics)*14 + 6px
// padding) + 6px gap. The handle dot sits at the vertical centre of
// the name row.
const HEADER_HEIGHT = 56;        // title row + meta pill row
const PORT_NAME_HEIGHT = 20;     // port name + handle alignment band
const PORT_TOPIC_HEIGHT = 14;    // each topic chip row inside the box
const PORT_BOX_VPAD = 6;         // padding above + below the topics inside the box
const PORT_GAP = 6;              // gap between consecutive port blocks
const PORT_BLOCK_MIN_TOPICS = 1; // empty ports still reserve one row so the box is visible

/** Total vertical height for a port block with `topicCount` bound topics. */
function portBlockHeight(topicCount: number): number {
  const rows = Math.max(PORT_BLOCK_MIN_TOPICS, topicCount);
  return PORT_NAME_HEIGHT + rows * PORT_TOPIC_HEIGHT + PORT_BOX_VPAD * 2 + PORT_GAP;
}

/** Vertical centre of the i-th port's name-row, measured from the top of
 *  the node — that's where the Handle dot anchors. */
function portHandleTop(blockHeights: number[], i: number): number {
  let y = HEADER_HEIGHT;
  for (let j = 0; j < i; j++) y += blockHeights[j];
  return y + PORT_NAME_HEIGHT / 2;
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

  // 2-layer wiring: build the port lists for each side. Each entry is
  // `{ name, topics }` — name = port identifier (the stable handle id),
  // topics = the bus subjects currently bound to that port. When the
  // node carries no ports (older peer, malformed snapshot), synthesise
  // a single anonymous port per legacy sub/pub so the card still draws.
  const inputPorts = data.ports?.inputs
    ? Object.keys(data.ports.inputs).map((name) => ({
        name,
        topics: data.portBindings?.inputs?.[name] ?? [],
      }))
    : data.subscribes.map((t) => ({ name: t, topics: [t] }));
  const outputPorts = data.ports?.outputs
    ? Object.keys(data.ports.outputs).map((name) => ({
        name,
        topics: data.portBindings?.outputs?.[name] ?? [],
      }))
    : data.publishes.map((t) => ({ name: t, topics: [t] }));

  // Pre-compute each port block's height so the handle dots can be
  // anchored at the exact vertical centre of their name-row without
  // a layout-effect round-trip.
  const inputHeights = inputPorts.map((p) => portBlockHeight(p.topics.length));
  const outputHeights = outputPorts.map((p) => portBlockHeight(p.topics.length));

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

  // Ref to the root element — used by NodeResizer's `onResize` to mutate
  // width/height directly during drag, bypassing React state so we don't
  // trigger a 60Hz re-layout of the whole graph (which makes neighbour
  // nodes vanish until the drag ends). On release `onResizeEnd` persists
  // the final size to state so it survives collapse/expand cycles.
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rootRef}
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
          // During drag: mutate this node's own DOM via ref so the card
          // visibly grows in real time, but DO NOT call setState — that
          // would re-fire the parent's layout effect at 60Hz and make
          // the rest of the graph flicker. On release we persist the
          // final size to state so it survives collapse/expand cycles.
          onResize={(_, p) => {
            const el = rootRef.current;
            if (!el) return;
            el.style.width = `${p.width}px`;
            el.style.height = `${p.height}px`;
          }}
          onResizeEnd={(_, p) => {
            (data.onResizeExpanded)?.(p.width, p.height);
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
                (data.onToggleExpand)?.();
              }}
              title={data.isExpanded ? "Collapse" : "Expand UI in place"}
              className="p-1 rounded text-text-muted hover:text-text hover:bg-surface-overlay transition-colors"
            >
              {data.isExpanded ? <IconChevronUp /> : <IconChevronDown />}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                (data.onOpenUi)?.();
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

      {/* === Ports + bound topics ===
          Each side renders its declared ports as stacked blocks. Within
          a block: the port name (bold), then a dashed-bordered sub-box
          listing the topics currently wired to that port. The visual
          association lets the user read "this group of topics IS this
          port" at a glance.
          The grid uses 1fr / 1fr columns so left + right widths are
          balanced even when one side has more ports. */}
      {(inputPorts.length > 0 || outputPorts.length > 0) && (
        <div
          className="grid pb-2 px-3 items-start"
          style={{ gridTemplateColumns: "1fr 1fr", columnGap: "12px" }}
        >
          {/* === Left column — INPUT ports === */}
          <div className="flex flex-col" style={{ rowGap: `${PORT_GAP}px` }}>
            {inputPorts.map((port) => (
              <PortBlock key={`in-${port.name}`} side="input" name={port.name} topics={port.topics} />
            ))}
          </div>
          {/* === Right column — OUTPUT ports === */}
          <div className="flex flex-col" style={{ rowGap: `${PORT_GAP}px` }}>
            {outputPorts.map((port) => (
              <PortBlock key={`out-${port.name}`} side="output" name={port.name} topics={port.topics} />
            ))}
          </div>
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
            src={`/node/${id}/ui/`}
            title={`${data.label} UI`}
            className="nodrag nowheel"
            style={{ width: "100%", height: "100%", border: 0, display: "block" }}
          />
        </div>
      )}

      {/* === ReactFlow Handles ===
          One handle per declared port. id = `in-<portName>` (left) or
          `out-<portName>` (right); `top` anchors the dot at the centre
          of the port-name row. The dot colour is hashed off the port
          name so the same port always reads the same hue across cards. */}
      {inputPorts.map((port, i) => (
        <Handle
          key={`in-${port.name}`}
          type="target"
          position={Position.Left}
          id={`in-${port.name}`}
          style={{ top: `${portHandleTop(inputHeights, i)}px`, background: topicColor(port.name) }}
          className="!w-2.5 !h-2.5 !border-0"
        />
      ))}
      {inputPorts.length === 0 && (
        <Handle type="target" position={Position.Left} id="in-default" className="opacity-0" />
      )}

      {outputPorts.map((port, i) => (
        <Handle
          key={`out-${port.name}`}
          type="source"
          position={Position.Right}
          id={`out-${port.name}`}
          style={{ top: `${portHandleTop(outputHeights, i)}px`, background: topicColor(port.name) }}
          className="!w-2.5 !h-2.5 !border-0"
        />
      ))}
      {outputPorts.length === 0 && (
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

/**
 * One port on a node card — the port's name as the "function" label,
 * with its bound topics listed in a dashed-bordered sub-box. The dashed
 * border is the visual cue: "everything inside this box flows through
 * the labelled port". Inputs anchor on the left (port name pushed
 * leftward, box flows down beneath); outputs mirror on the right.
 *
 * The handle dot itself isn't rendered here — handles live as React
 * Flow `<Handle>` siblings on the node root with absolute positioning,
 * because React Flow requires them at fixed offsets it can read for
 * edge routing. This component just lays out the matching label band.
 */
function PortBlock({
  side, name, topics,
}: { side: "input" | "output"; name: string; topics: string[] }): React.ReactElement {
  const align = side === "input" ? "items-start text-left" : "items-end text-right";
  return (
    <div className={`flex flex-col ${align}`}>
      <div
        className="font-mono font-semibold text-[11px] text-text px-1 truncate w-full"
        style={{ height: `${PORT_NAME_HEIGHT}px`, lineHeight: `${PORT_NAME_HEIGHT}px` }}
        title={name}
      >
        {name}
      </div>
      <div
        className="rounded border border-dashed border-border/70 bg-surface-overlay/30 w-full"
        style={{ padding: `${PORT_BOX_VPAD}px 4px` }}
      >
        {topics.length === 0 ? (
          <div
            className="text-[9px] italic text-text-muted/70 px-0.5 truncate"
            style={{ height: `${PORT_TOPIC_HEIGHT}px`, lineHeight: `${PORT_TOPIC_HEIGHT}px` }}
            title="orphan port — no topic wired"
          >
            (unbound)
          </div>
        ) : (
          topics.map((topic) => (
            <div
              key={topic}
              className="flex items-center gap-1 px-0.5 min-w-0"
              style={{ height: `${PORT_TOPIC_HEIGHT}px`, lineHeight: `${PORT_TOPIC_HEIGHT}px`, flexDirection: side === "output" ? "row-reverse" : "row" }}
            >
              <span
                className="w-1 h-1 rounded-full shrink-0"
                style={{ background: topicColor(topic) }}
              />
              <span className="text-[10px] font-mono text-text-muted truncate" title={topic}>{topic}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
