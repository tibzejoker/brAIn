interface HeaderProps {
  onSpawnClick: () => void;
  /** Mobile-only: open the side menu drawer. The hamburger button only
   *  appears on small viewports (<md); on desktop the Menu rail is always
   *  visible and this prop is unused. */
  onMenuToggle?: () => void;
}

export function Header({ onSpawnClick, onMenuToggle }: HeaderProps): React.ReactElement {
  return (
    <header className="flex items-center justify-between px-4 md:px-6 py-2 md:py-3 border-b border-border bg-surface-raised">
      <div className="flex items-center gap-3 md:gap-4 min-w-0">
        {/* Hamburger — mobile only (<md). Drives the side-drawer in App.tsx. */}
        {onMenuToggle && (
          <button
            onClick={onMenuToggle}
            aria-label="Open menu"
            className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-md text-text hover:bg-surface-overlay transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        <img
          src="/brain-logo.svg"
          alt="brAIn"
          className="h-8 w-auto shrink-0"
        />
        <span className="hidden sm:inline text-sm text-text-muted truncate">Network Monitor</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onSpawnClick}
          className="inline-flex items-center justify-center min-h-[40px] md:min-h-0 px-3 py-1.5 text-sm font-medium rounded-md bg-accent text-accent-fg hover:bg-accent-hover transition-colors"
        >
          + Spawn
        </button>
      </div>
    </header>
  );
}
