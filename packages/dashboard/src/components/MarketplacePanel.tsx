import { useState } from "react";
import { LibrariesView } from "./marketplace/LibrariesView";
import { SeedsView } from "./marketplace/SeedsView";

type SubTab = "seeds" | "libraries";

/**
 * Unified Marketplace — replaces the legacy Store + Seeds tabs.
 *  - Seeds:     local + marketplace seeds in one searchable list (default).
 *  - Libraries: nodes grouped by their owning sister repo
 *               (one card per lib, e.g. brAIn-memory · 5 nodes).
 *
 * Both views share a module-level cache via `useMarketplace()` so
 * flipping between sub-tabs is instant. The cache is invalidated
 * only on explicit "Pull marketplace" or "Refresh view".
 */
export function MarketplacePanel({ onChanged }: { onChanged: () => void }): React.ReactElement {
  const [tab, setTab] = useState<SubTab>("seeds");
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text">Marketplace</h2>
        <div className="flex bg-surface-overlay rounded-md p-0.5">
          <SubTabBtn active={tab === "seeds"} onClick={() => setTab("seeds")}>Seeds</SubTabBtn>
          <SubTabBtn active={tab === "libraries"} onClick={() => setTab("libraries")}>Libraries</SubTabBtn>
        </div>
      </div>
      {tab === "seeds" && <SeedsView onChanged={onChanged} />}
      {tab === "libraries" && <LibrariesView onChanged={onChanged} />}
    </div>
  );
}

function SubTabBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs rounded transition-colors ${
        active ? "bg-accent text-accent-fg" : "text-text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
