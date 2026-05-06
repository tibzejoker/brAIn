import type { ReactElement, ReactNode } from "react";

/**
 * Sub-components of NodeCreator extracted to keep the main file under
 * the lint line cap. They're presentation-only — no state, all behaviour
 * comes from the parent through props.
 */

interface GroupProps {
  label: string;
  sublabel?: string;
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function Group({ label, sublabel, count, isCollapsed, onToggle, children }: GroupProps): ReactElement {
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-overlay/50 hover:bg-surface-overlay transition-colors text-left"
      >
        <span className="text-text-muted text-xs">{isCollapsed ? "▸" : "▾"}</span>
        <span className="font-medium text-sm text-text">{label}</span>
        {sublabel && (
          <code className="text-[10px] text-text-muted font-mono truncate">{sublabel}</code>
        )}
        <span className="ml-auto text-[11px] text-text-muted">
          {count} type{count > 1 ? "s" : ""}
        </span>
      </button>
      {!isCollapsed && (
        <div className="divide-y divide-border/60">{children}</div>
      )}
    </div>
  );
}

interface TypeRowProps {
  name: string;
  description: string;
  running: number;
  selected: boolean;
  onClick: () => void;
}

export function TypeRow({ name, description, running, selected, onClick }: TypeRowProps): ReactElement {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
        selected
          ? "bg-accent/15 border-l-2 border-accent pl-[10px]"
          : "hover:bg-surface-overlay/40"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text truncate">{name}</div>
        <div className="text-[11px] text-text-muted truncate">{description}</div>
      </div>
      <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${
        running > 0
          ? "bg-node-active/15 text-node-active"
          : "bg-surface-overlay text-text-muted"
      }`}>
        {running} running
      </span>
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="px-3 py-2 text-[11px] text-text-muted italic">{children}</div>
  );
}
