import { useState, useEffect, useRef, useCallback } from "react";
import type { NodeSnapshot } from "../api/types";
import { onMessagePublished, isInfraTopic } from "../api/socket";
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
  // Hold nodes in a ref so recordMessage stays referentially stable. Without
  // this it was recreated on every nodes change (~every snapshot, 2+ hubs),
  // which re-fired the seed effect below → a getMessages({last:100}) storm +
  // full recompute on a loop that wedged the tab.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const computeFlows = useCallback((): void => {
    setFlows(Array.from(flowMapRef.current.values()));
  }, []);

  const recordMessage = useCallback(
    (fromNodeId: string, topic: string): void => {
      // Infra topics (snapshots/cursors/discovery/telemetry/commands) aren't
      // node-to-node conversation flows — skip them entirely.
      if (isInfraTopic(topic)) return;
      for (const node of nodesRef.current) {
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
    [],
  );

  // Seed from history on mount (once — recordMessage is now stable).
  useEffect(() => {
    getMessages({ last: 100, exclude: "brain.network.*,brain.agents.*,llm.usage" })
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
