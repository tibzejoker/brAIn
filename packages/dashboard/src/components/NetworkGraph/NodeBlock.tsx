import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

type NodeBlockData = Node<{
  label: string;
  nodeType: string;
  state: string;
  transport: string;
  tags: string[];
  hasUi: boolean;
  onOpenUi?: () => void;
  subscribes: string[];
  publishes: string[];
  unreadCount: number;
}>;

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

  return (
    <div
      className={`
        relative px-4 py-3 rounded-lg border-2 bg-surface-raised
        ${borderColor}
        ${selected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""}
        min-w-[200px] cursor-pointer transition-shadow hover:shadow-lg
      `}
    >
      {/* Left handles — one per subscription */}
      {data.subscribes.map((topic, i) => (
        <Handle
          key={`in-${topic}`}
          type="target"
          position={Position.Left}
          id={`in-${topic}`}
          style={{ top: `${20 + i * 16}px`, background: topicColor(topic) }}
          className="!w-2 !h-2 !border-0"
        />
      ))}
      {data.subscribes.length === 0 && (
        <Handle type="target" position={Position.Left} id="in-default" className="opacity-0" />
      )}

      {/* Unread badge */}
      {data.unreadCount > 0 && (
        <div className="absolute -top-2 -right-2 min-w-[20px] h-5 px-1.5 rounded-full bg-node-stopped text-white text-[10px] font-bold flex items-center justify-center shadow-lg">
          {data.unreadCount}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2.5 h-2.5 rounded-full ${dotColor} shrink-0`} />
        <span className="font-semibold text-sm text-text truncate">{data.label}</span>
      </div>

      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className="px-1.5 py-0.5 rounded bg-surface-overlay">{data.nodeType}</span>
        {data.hasUi && (
          <button
            onClick={(e) => { e.stopPropagation(); (data.onOpenUi as (() => void) | undefined)?.(); }}
            className="px-1.5 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          >
            UI
          </button>
        )}
      </div>

      {/* Subscriptions (left side labels) */}
      {data.subscribes.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {data.subscribes.map((topic) => (
            <div key={topic} className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: topicColor(topic) }} />
              <span className="text-[9px] text-text-muted truncate">{topic}</span>
            </div>
          ))}
        </div>
      )}

      {/* Publishes (right side labels) */}
      {data.publishes.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {data.publishes.map((topic) => (
            <div key={topic} className="flex items-center justify-end gap-1">
              <span className="text-[9px] text-text-muted truncate">{topic}</span>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: topicColor(topic) }} />
            </div>
          ))}
        </div>
      )}

      {/* Right handles — one per publish topic */}
      {data.publishes.map((topic, i) => (
        <Handle
          key={`out-${topic}`}
          type="source"
          position={Position.Right}
          id={`out-${topic}`}
          style={{ top: `${20 + i * 16}px`, background: topicColor(topic) }}
          className="!w-2 !h-2 !border-0"
        />
      ))}
      {data.publishes.length === 0 && (
        <Handle type="source" position={Position.Right} id="out-default" className="opacity-0" />
      )}
    </div>
  );
}
