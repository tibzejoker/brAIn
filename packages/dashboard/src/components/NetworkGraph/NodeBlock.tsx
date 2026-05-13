import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

type NodeBlockData = Node<{
  label: string;
  nodeType: string;
  state: string;
  transport: string;
  targetAgentId?: string;
  tags: string[];
  hasUi: boolean;
  onOpenUi?: () => void;
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

export function NodeBlock({ data, selected }: NodeProps<NodeBlockData>): React.ReactElement {
  const borderColor = STATE_COLORS[data.state] ?? "border-border";
  const dotColor = STATE_DOTS[data.state] ?? "bg-node-terminated";

  // Number of IO rows we need to render — one per input OR output,
  // whichever side has more. A row may have an input but no output (or
  // vice versa); the empty side is just a placeholder for alignment.
  const ioRowCount = Math.max(data.subscribes.length, data.publishes.length);

  return (
    <div
      className={`
        relative rounded-lg border-2 bg-surface-raised
        ${borderColor}
        ${selected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""}
        min-w-[260px] cursor-pointer transition-shadow hover:shadow-lg
      `}
    >
      {/* Unread badge */}
      {data.unreadCount > 0 && (
        <div className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1.5 rounded-full bg-node-stopped text-white text-[10px] font-bold flex items-center justify-center shadow-lg z-10">
          {data.unreadCount}
        </div>
      )}

      {/* Authority chip — only when the capability layer is toggled on. */}
      {data.showCapabilityLayer && (
        <div
          className={`absolute -top-2 -left-2 px-1.5 h-5 rounded text-[10px] font-bold flex items-center shadow-lg z-10 ${AUTHORITY_CHIP[data.authorityLevel]?.cls ?? AUTHORITY_CHIP[0].cls}`}
        >
          {AUTHORITY_CHIP[data.authorityLevel]?.label ?? "BASIC"}
        </div>
      )}

      {/* Capability legend at the hovered node — labels above/below
          double as a colour legend for the red/cyan authority edges.
          Hidden for cases that don't apply: ROOT can't be controlled,
          BASIC has no outgoing capabilities. */}
      {data.showCapabilityLayer && data.isHovered && (
        <>
          {data.authorityLevel < 2 && (
            <div className="absolute left-1/2 -translate-x-1/2 -top-12 flex flex-col items-center gap-0.5 text-[10px] font-bold whitespace-nowrap pointer-events-none leading-tight">
              <span style={{ color: AUTH_CONTROL_COLOR }}>↑ controlled by</span>
              <span style={{ color: AUTH_INSPECT_COLOR }}>↑ inspected by</span>
            </div>
          )}
          {data.authorityLevel === 2 && (
            <div className="absolute left-1/2 -translate-x-1/2 -top-7 flex items-center text-[10px] font-bold whitespace-nowrap pointer-events-none leading-tight">
              <span style={{ color: AUTH_INSPECT_COLOR }}>↑ inspected by</span>
            </div>
          )}
          {data.authorityLevel >= 1 && (
            <div className="absolute left-1/2 -translate-x-1/2 -bottom-12 flex flex-col items-center gap-0.5 text-[10px] font-bold whitespace-nowrap pointer-events-none leading-tight">
              <span style={{ color: AUTH_CONTROL_COLOR }}>↓ controls</span>
              <span style={{ color: AUTH_INSPECT_COLOR }}>↓ inspects</span>
            </div>
          )}
        </>
      )}

      {/* === Header (centered) ===
          Fixed height matches HEADER_HEIGHT so handle positions line up. */}
      <div className="px-3 pt-2 pb-1 flex items-center justify-center gap-2">
        <span className={`w-2.5 h-2.5 rounded-full ${dotColor} shrink-0`} />
        <span className="font-semibold text-sm text-text truncate">{data.label}</span>
        {data.hasUi && (
          <button
            onClick={(e) => { e.stopPropagation(); (data.onOpenUi as (() => void) | undefined)?.(); }}
            className="px-1.5 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors text-[10px]"
          >
            UI
          </button>
        )}
      </div>

      {/* Meta pills row (still in the header band) */}
      <div className="px-3 pb-2 flex items-center justify-center gap-1.5 text-[10px] text-text-muted">
        <span className="px-1.5 py-0.5 rounded bg-surface-overlay">{data.nodeType}</span>
        {data.transport === "remote" && (
          <span
            title={`hosted on remote agent${data.targetAgentId ? ` "${data.targetAgentId}"` : ""}`}
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

      {/* Authority handles (top = incoming, bottom = outgoing). Always
          mounted when the capability layer is on so the graph can route
          edges through them without an extra re-render dance. The dots
          themselves stay invisible — only the edge stroke is visible. */}
      {data.showCapabilityLayer && (
        <>
          <Handle type="target" position={Position.Top}    id="auth-in"  className="opacity-0" />
          <Handle type="source" position={Position.Bottom} id="auth-out" className="opacity-0" />
        </>
      )}
    </div>
  );
}
