import type { NodeSnapshot } from "../api/types";

interface HeaderProps {
  nodes: NodeSnapshot[];
  devMode: boolean;
  onSpawnClick: () => void;
  onDevModeToggle: () => void;
  onTickAll: () => void;
}

function countByState(nodes: NodeSnapshot[], state: string): number {
  return nodes.filter((n) => n.state === state).length;
}

export function Header({
  nodes,
  devMode,
  onSpawnClick,
  onDevModeToggle,
  onTickAll,
}: HeaderProps): React.ReactElement {
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
        {devMode && (
          <span className="px-2 py-0.5 text-xs font-medium rounded bg-node-sleeping/20 text-node-sleeping">
            DEV MODE
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
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

        <div className="flex items-center gap-2 border-l border-border pl-4">
          {devMode && (
            <button
              onClick={onTickAll}
              className="px-3 py-1.5 text-sm font-medium rounded-md bg-node-active/20 text-node-active hover:bg-node-active/30 transition-colors"
            >
              Step All
            </button>
          )}

          <button
            onClick={onDevModeToggle}
            role="switch"
            aria-checked={devMode}
            className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none"
            style={{ backgroundColor: devMode ? "var(--color-node-sleeping)" : "var(--color-border-bright)" }}
          >
            <span
              className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
              style={{ transform: devMode ? "translateX(22px)" : "translateX(4px)" }}
            />
          </button>
          <span className="text-xs text-text-muted">
            {devMode ? "Manual" : "Auto"}
          </span>

          <button
            onClick={onSpawnClick}
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            + Spawn
          </button>
        </div>
      </div>
    </header>
  );
}
