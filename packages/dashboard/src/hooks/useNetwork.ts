import { useState, useEffect, useCallback } from "react";
import type { NetworkSnapshot, NodeSnapshot } from "../api/types";
import { getNetwork } from "../api/client";
import {
  onNodeSpawned,
  onNodeKilled,
  onNodeStateChanged,
  onNetworkHubSnapshot,
  onNetworkHubExpired,
} from "../api/socket";

interface UseNetworkResult {
  nodes: NodeSnapshot[];
  nodeCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Cheap render-relevant signature of a node. Peer hubs re-publish their
 *  full snapshot every few seconds; if nothing that affects rendering
 *  changed we must NOT replace the nodes array, or React Flow re-lays-out
 *  the whole graph on a timer — which pegs a phone until it reloads. */
function nodeSig(n: NodeSnapshot): string {
  return `${n.id}:${n.state}:${Math.round(n.position.x)},${Math.round(n.position.y)}`;
}
function sameNodeSet(a: NodeSnapshot[], b: NodeSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map(nodeSig).sort();
  const sb = b.map(nodeSig).sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

export function useNetwork(): UseNetworkResult {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot>({
    node_count: 0,
    nodes: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    setLoading(true);
    getNetwork()
      .then((data) => {
        setSnapshot(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubs = [
      onNodeSpawned((node) => {
        setSnapshot((prev) => ({
          node_count: prev.node_count + 1,
          nodes: [...prev.nodes, node],
        }));
      }),
      onNodeKilled((event) => {
        setSnapshot((prev) => ({
          node_count: prev.node_count - 1,
          nodes: prev.nodes.filter((n) => n.id !== event.nodeId),
        }));
      }),
      onNodeStateChanged((event) => {
        setSnapshot((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === event.nodeId ? { ...n, state: event.to } : n,
          ),
        }));
      }),
      // Peer hub pushed its registry: drop whatever we held for that hub and
      // replace it with the fresh set (each node already tagged owner_hub).
      onNetworkHubSnapshot((event) => {
        setSnapshot((prev) => {
          // No-op when this hub's set is unchanged — avoids a full graph
          // re-render on every periodic snapshot (the mobile-killer).
          const mine = prev.nodes.filter((n) => n.owner_hub?.hub_id === event.hub.hub_id);
          if (sameNodeSet(mine, event.nodes)) return prev;
          const others = prev.nodes.filter((n) => n.owner_hub?.hub_id !== event.hub.hub_id);
          const nodes = [...others, ...event.nodes];
          return { node_count: nodes.length, nodes };
        });
      }),
      // Peer hub gone — remove all its nodes from the merged view.
      onNetworkHubExpired((event) => {
        setSnapshot((prev) => {
          const nodes = prev.nodes.filter((n) => n.owner_hub?.hub_id !== event.hub_id);
          return { node_count: nodes.length, nodes };
        });
      }),
    ];

    return (): void => {
      for (const unsub of unsubs) unsub();
    };
  }, []);

  return {
    nodes: snapshot.nodes,
    nodeCount: snapshot.node_count,
    loading,
    error,
    refresh,
  };
}
