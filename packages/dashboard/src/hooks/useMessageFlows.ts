import { useState, useEffect, useRef, useCallback } from "react";
import type { NodeSnapshot } from "../api/types";
import { onMessagePublished } from "../api/socket";
import { getMessages } from "../api/client";

interface Flow {
  sourceId: string;
  targetId: string;
  topic: string;
  count: number;
  lastSeen: number;
}

function matchWildcard(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return topic.startsWith(prefix);
  }
  return false;
}

export function useMessageFlows(nodes: NodeSnapshot[]): Flow[] {
  // Map: "sourceId->targetId:topic" -> Flow
  const flowMapRef = useRef(new Map<string, Flow>());
  const [flows, setFlows] = useState<Flow[]>([]);

  const computeFlows = useCallback((): void => {
    setFlows(Array.from(flowMapRef.current.values()));
  }, []);

  const recordMessage = useCallback(
    (fromNodeId: string, topic: string): void => {
      for (const node of nodes) {
        if (node.id === fromNodeId) continue;

        for (const sub of node.subscriptions) {
          if (matchWildcard(sub.pattern, topic)) {
            const key = `${fromNodeId}->${node.id}:${topic}`;
            const existing = flowMapRef.current.get(key);
            if (existing) {
              existing.count++;
              existing.lastSeen = Date.now();
            } else {
              flowMapRef.current.set(key, {
                sourceId: fromNodeId,
                targetId: node.id,
                topic,
                count: 1,
                lastSeen: Date.now(),
              });
            }
          }
        }
      }
    },
    [nodes],
  );

  // Seed from history on mount
  useEffect(() => {
    getMessages({ last: 100 })
      .then((msgs) => {
        for (const msg of msgs) {
          recordMessage(msg.from, msg.topic);
        }
        computeFlows();
      })
      .catch(() => {
        /* silent */
      });
  }, [recordMessage, computeFlows]);

  // Live updates
  useEffect(() => {
    let tick: ReturnType<typeof setInterval> | undefined;

    const unsub = onMessagePublished((msg) => {
      recordMessage(msg.from, msg.topic);
      // Batch flow updates every 500ms to avoid excessive re-renders
      if (!tick) {
        tick = setInterval(() => {
          computeFlows();
          clearInterval(tick);
          tick = undefined;
        }, 500);
      }
    });

    return (): void => {
      unsub();
      if (tick) clearInterval(tick);
    };
  }, [recordMessage, computeFlows]);

  return flows;
}
