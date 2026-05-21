import { ViewportPortal } from "@xyflow/react";
import type { CursorUpdate } from "../../api/types";

/**
 * Other machines' pointers, rendered in flow-coordinate space (via
 * ViewportPortal) so they pan/zoom with the graph. Each cursor carries a
 * CSS transition on its transform, so the throttled (~10/s) position
 * updates are interpolated into smooth motion instead of jumping.
 */
export function RemoteCursors({ cursors }: { cursors: CursorUpdate[] }): React.ReactElement {
  return (
    <ViewportPortal>
      {cursors.map((c) => (
        <div
          key={c.hub_id}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transform: `translate(${c.x}px, ${c.y}px)`,
            transition: "transform 0.12s linear",
            pointerEvents: "none",
            zIndex: 1000,
            color: colorFor(c.hub_id),
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" style={{ filter: "drop-shadow(0 1px 1px rgba(0,0,0,.5))" }}>
            <path d="M5 3l15 9-7 1.5L9 21z" fill="currentColor" stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          <span
            style={{
              marginLeft: 14, marginTop: -6, display: "inline-block",
              background: colorFor(c.hub_id), color: "#fff",
              fontSize: 10, fontWeight: 600, padding: "1px 6px",
              borderRadius: 6, whiteSpace: "nowrap",
            }}
          >
            {c.label}
          </span>
        </div>
      ))}
    </ViewportPortal>
  );
}

/** Stable per-hub colour from its id. */
function colorFor(hubId: string): string {
  let h = 0;
  for (let i = 0; i < hubId.length; i++) h = (h * 31 + hubId.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 55%)`;
}
