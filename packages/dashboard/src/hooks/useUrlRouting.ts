/**
 * Lightweight URL ⇄ view routing for the dashboard.
 *
 * The app is a single canvas with panels driven by two pieces of state:
 * the active menu view and an optional fullscreen node-UI overlay. Rather
 * than pull in react-router, we mirror those two into the URL path so each
 * "page" is bookmarkable, shareable, and survives a reload (the API + Vite
 * already serve index.html for any non-API GET — the SPA fallback). Back /
 * forward work via popstate.
 *
 * Path scheme (deliberately avoids the API's top-level routes so a direct
 * hit / reload isn't swallowed by the dev proxy or a prod controller:
 * `agents`, `llm`, `node`, `nodes`, `network`, `store`, `tools`, `types`,
 * `mcp` are all backend paths):
 *   /                      → graph
 *   /history               → history
 *   /marketplace           → marketplace
 *   /library               → skills (procedural-memory) library
 *   /distributed           → agents/remote-hosts view
 *   /models                → LLM settings
 *   /ui/<id>               → fullscreen node UI overlay (over the graph)
 */
import { useCallback, useEffect, useState } from "react";
import type { MenuView } from "../components/Menu";

const VIEW_PATHS: Record<MenuView, string> = {
  graph: "/",
  history: "/history",
  marketplace: "/marketplace",
  skills: "/library",
  agents: "/distributed",
  llm: "/models",
};

const PATH_VIEWS: Record<string, MenuView> = {
  "": "graph",
  graph: "graph",
  history: "history",
  marketplace: "marketplace",
  library: "skills",
  distributed: "agents",
  models: "llm",
};

interface RouteState {
  view: MenuView;
  /** Node id whose fullscreen UI is open, or null. */
  nodeId: string | null;
}

function parsePath(pathname: string): RouteState {
  const seg = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (seg[0] === "ui" && seg[1]) {
    return { view: "graph", nodeId: decodeURIComponent(seg[1]) };
  }
  return { view: PATH_VIEWS[seg[0] ?? ""] ?? "graph", nodeId: null };
}

function buildPath(state: RouteState): string {
  if (state.nodeId) return `/ui/${encodeURIComponent(state.nodeId)}`;
  return VIEW_PATHS[state.view];
}

export interface UrlRouting {
  view: MenuView;
  nodeId: string | null;
  /** Switch the primary view (closes any open node overlay). */
  setView: (view: MenuView) => void;
  /** Open a node's fullscreen UI (keeps the underlying view). */
  openNode: (nodeId: string) => void;
  closeNode: () => void;
}

export function useUrlRouting(): UrlRouting {
  const [state, setState] = useState<RouteState>(() => parsePath(window.location.pathname));

  // Reflect state → URL. Guard against re-pushing the path we're already on
  // (e.g. the initial mount, or a popstate-driven update).
  useEffect(() => {
    const target = buildPath(state);
    if (window.location.pathname !== target) {
      window.history.pushState(null, "", target);
    }
  }, [state]);

  // URL → state on back/forward.
  useEffect(() => {
    const onPop = (): void => setState(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setView = useCallback((view: MenuView): void => setState({ view, nodeId: null }), []);
  const openNode = useCallback((nodeId: string): void => setState((s) => ({ ...s, nodeId })), []);
  const closeNode = useCallback((): void => setState((s) => ({ ...s, nodeId: null })), []);

  return { view: state.view, nodeId: state.nodeId, setView, openNode, closeNode };
}
