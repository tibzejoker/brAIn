import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

type NodeBlockData = Node<{
  label: string;
  nodeType: string;
  state: string;
  transport: string;
  tags: string[];
  hasUi: boolean;
  onOpenUi?: () => void;
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

export function NodeBlock({ data, selected }: NodeProps<NodeBlockData>): React.ReactElement {
  const borderColor = STATE_COLORS[data.state] ?? "border-border";
  const dotColor = STATE_DOTS[data.state] ?? "bg-node-terminated";

  return (
    <div
      className={`
        px-4 py-3 rounded-lg border-2 bg-surface-raised
        ${borderColor}
        ${selected ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""}
        min-w-[200px] cursor-pointer transition-shadow hover:shadow-lg
      `}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" />

      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2.5 h-2.5 rounded-full ${dotColor} shrink-0`} />
        <span className="font-semibold text-sm text-text truncate">
          {data.label}
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className="px-1.5 py-0.5 rounded bg-surface-overlay">
          {data.nodeType}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-surface-overlay">
          {data.transport}
        </span>
        {data.hasUi && (
          <button
            onClick={(e) => { e.stopPropagation(); (data.onOpenUi as (() => void) | undefined)?.(); }}
            className="px-1.5 py-0.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          >
            UI
          </button>
        )}
      </div>

      {data.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {data.tags.slice(0, 3).map((tag: string) => (
            <span
              key={tag}
              className="px-1 py-0.5 text-[10px] rounded bg-surface-overlay text-text-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="opacity-0" />
    </div>
  );
}
