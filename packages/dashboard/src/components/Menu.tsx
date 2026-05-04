export type MenuView = "graph" | "history" | "marketplace" | "agents";

interface MenuProps {
  active: MenuView;
  onChange: (view: MenuView) => void;
  /** Hide the Agents tab when NATS isn't wired — it'd be empty forever. */
  showAgents?: boolean;
}

const ITEMS: Array<{ key: MenuView; label: string; icon: string }> = [
  { key: "graph", label: "Network", icon: "◉" },
  { key: "history", label: "History", icon: "◷" },
  { key: "marketplace", label: "Marketplace", icon: "⊞" },
  { key: "agents", label: "Agents", icon: "⚯" },
];

export function Menu({ active, onChange, showAgents = false }: MenuProps): React.ReactElement {
  const items = showAgents ? ITEMS : ITEMS.filter((i) => i.key !== "agents");
  return (
    <nav className="w-14 bg-surface-raised border-r border-border flex flex-col items-center py-3 gap-1 shrink-0">
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onChange(item.key)}
          title={item.label}
          className={`
            w-10 h-10 rounded-lg flex items-center justify-center text-lg transition-colors
            ${active === item.key
              ? "bg-accent text-white"
              : "text-text-muted hover:bg-surface-overlay hover:text-text"}
          `}
        >
          {item.icon}
        </button>
      ))}
    </nav>
  );
}
