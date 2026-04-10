import { useState, useEffect, useCallback } from "react";
import type { NodeSnapshot } from "../api/types";
import { getNode } from "../api/client";
import { onNodeStateChanged, onNodeKilled } from "../api/socket";

interface UseSelectedNodeResult {
  node: NodeSnapshot | null;
  select: (id: string | null) => void;
  refresh: () => void;
}

export function useSelectedNode(): UseSelectedNodeResult {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [node, setNode] = useState<NodeSnapshot | null>(null);

  const fetchNode = useCallback((id: string): void => {
    getNode(id)
      .then((data) => {
        setNode(data);
      })
      .catch(() => {
        setNode(null);
      });
  }, []);

  const select = useCallback(
    (id: string | null): void => {
      setNodeId(id);
      if (id) {
        fetchNode(id);
      } else {
        setNode(null);
      }
    },
    [fetchNode],
  );

  const refresh = useCallback((): void => {
    if (nodeId) {
      fetchNode(nodeId);
    }
  }, [nodeId, fetchNode]);

  useEffect(() => {
    const unsubs = [
      onNodeStateChanged((event) => {
        if (event.nodeId === nodeId) {
          refresh();
        }
      }),
      onNodeKilled((event) => {
        if (event.nodeId === nodeId) {
          setNode(null);
          setNodeId(null);
        }
      }),
    ];

    return (): void => {
      for (const unsub of unsubs) unsub();
    };
  }, [nodeId, refresh]);

  return { node, select, refresh };
}
