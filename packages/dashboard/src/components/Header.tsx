import type { NodeSnapshot } from "../api/types";

interface HeaderProps {
  nodes: NodeSnapshot[];
  onSpawnClick: () => void;
}

function countByState(nodes: NodeSnapshot[], state: string): number {
  return nodes.filter((n) => n.state === state).length;
}

export function Header({ nodes, onSpawnClick }: HeaderProps): React.ReactElement {
  const active = countByState(nodes, "active");
  const sleeping = countByState(nodes, "sleeping");
  const stopped = countByState(nodes, "stopped");

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-surface-raised">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold tracking-tight text-text">
          brAIn
        </h1>
        <span className="text-sm text-text-muted">Network Monitor</span>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-node-active" />
            <span className="text-text-muted">{active} active</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-node-sleeping" />
            <span className="text-text-muted">{sleeping} sleeping</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-node-stopped" />
            <span className="text-text-muted">{stopped} stopped</span>
          </span>
        </div>

        <button
          onClick={onSpawnClick}
          className="px-3 py-1.5 text-sm font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          + Spawn Node
        </button>
      </div>
    </header>
  );
}
