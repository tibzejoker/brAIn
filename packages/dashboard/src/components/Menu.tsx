export type MenuView = "graph" | "history" | "marketplace" | "skills" | "agents" | "llm";

interface MenuProps {
  active: MenuView;
  onChange: (view: MenuView) => void;
  /** Mobile drawer open state. On desktop the Menu rail is always
   *  rendered next to the main area; on mobile it becomes a full-height
   *  drawer that slides in from the left when this is true. */
  mobileOpen?: boolean;
  /** Called from a backdrop click or after a menu item is picked, so
   *  the drawer auto-closes once the user navigates. Desktop ignores. */
  onMobileClose?: () => void;
}

const ITEMS: Array<{ key: MenuView; label: string; icon: string }> = [
  { key: "graph", label: "Network", icon: "◉" },
  { key: "history", label: "History", icon: "◷" },
  { key: "marketplace", label: "Marketplace", icon: "⊞" },
  { key: "skills", label: "Skills", icon: "✸" },
  { key: "agents", label: "Distributed", icon: "⚯" },
  { key: "llm", label: "LLM Providers", icon: "✦" },
];

export function Menu({ active, onChange, mobileOpen = false, onMobileClose }: MenuProps): React.ReactElement {
  const handlePick = (view: MenuView): void => {
    onChange(view);
    onMobileClose?.();
  };

  return (
    <>
      {/* Mobile backdrop — only when the drawer is open. Click to close. */}
      {mobileOpen && (
        <div
          onClick={onMobileClose}
          className="md:hidden fixed inset-0 z-30 bg-black/60"
          aria-hidden
        />
      )}

      <nav
        className={`
          bg-surface-raised border-r border-border flex flex-col py-3 gap-1 shrink-0
          md:static md:w-14 md:items-center md:translate-x-0
          fixed inset-y-0 left-0 z-40 w-56 items-stretch px-2
          transition-transform duration-200
          ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
        `}
      >
        {ITEMS.map((item) => (
          <button
            key={item.key}
            onClick={() => handlePick(item.key)}
            title={item.label}
            className={`
              flex items-center gap-3 md:gap-0 md:justify-center md:w-10
              h-11 md:h-10 px-3 md:px-0 rounded-lg text-base md:text-lg transition-colors
              ${active === item.key
                ? "bg-accent text-accent-fg"
                : "text-text-muted hover:bg-surface-overlay hover:text-text"}
            `}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="md:hidden text-sm font-medium">{item.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
