/**
 * Small UI primitives used only by NodePanel. Extracted so NodePanel
 * itself stays under the 300-line cap as the per-tab content grows.
 */

export function TabButton({ label, active, onClick, warn = false }: {
  label: string;
  active: boolean;
  onClick: () => void;
  warn?: boolean;
}): React.ReactElement {
  const base = "px-4 py-2 text-xs font-medium transition-colors";
  const tone = active
    ? "text-accent border-b-2 border-accent"
    : warn
      ? "text-node-stopped hover:text-node-stopped/80"
      : "text-text-muted hover:text-text";
  return (
    <button onClick={onClick} className={`${base} ${tone}`}>
      {label}
    </button>
  );
}

export function InfoRow({ label, value, mono = false }: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-text-muted shrink-0">{label}</span>
      <span className={`text-text truncate text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

export function ActionButton({ label, variant, loading, onClick }: {
  label: string;
  variant: "success" | "warning" | "danger";
  loading: boolean;
  onClick: () => void;
}): React.ReactElement {
  const colors = {
    success: "bg-node-active/20 text-node-active hover:bg-node-active/30",
    warning: "bg-node-sleeping/20 text-node-sleeping hover:bg-node-sleeping/30",
    danger: "bg-node-stopped/20 text-node-stopped hover:bg-node-stopped/30",
  };
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${colors[variant]}`}
    >
      {label}
    </button>
  );
}
