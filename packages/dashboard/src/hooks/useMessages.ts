import { useState, useEffect, useRef, useCallback } from "react";
import type { Message } from "../api/types";
import { getMessages } from "../api/client";
import { onMessagePublished, isInfraTopic } from "../api/socket";

const MAX_MESSAGES = 500;
const INFRA_EXCLUDE = "brain.network.*,brain.agents.*,llm.usage";

interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  topicFilter: string;
  setTopicFilter: (v: string) => void;
  minCriticality: number;
  setMinCriticality: (v: number) => void;
  /** Framework infra topics (snapshots/cursors/discovery/telemetry) are
   *  hidden by default — flip this to include them. */
  showInfra: boolean;
  setShowInfra: (v: boolean) => void;
}

export function useMessages(): UseMessagesResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [topicFilter, setTopicFilter] = useState("");
  const [minCriticality, setMinCriticality] = useState(0);
  const [showInfra, setShowInfra] = useState(false);
  const bufferRef = useRef<Message[]>([]);
  // Read by the socket handler (set up once) so the toggle takes effect
  // without re-subscribing.
  const showInfraRef = useRef(showInfra);
  showInfraRef.current = showInfra;

  // (Re)seed history whenever the infra toggle flips — honored server-side so
  // we never even pull the noisy payloads when hidden (the default).
  useEffect(() => {
    setLoading(true);
    getMessages(showInfra ? { last: 50 } : { last: 50, exclude: INFRA_EXCLUDE })
      .then((initial) => {
        bufferRef.current = initial;
        setMessages(initial);
      })
      .catch(() => {
        /* initial fetch failed, socket will populate */
      })
      .finally(() => {
        setLoading(false);
      });
  }, [showInfra]);

  useEffect(() => {
    // Buffer raw messages on the ref (lossless) and coalesce React
    // re-renders to one per animation frame. Without this, a high-
    // frequency publisher (e.g. mobile accel @ 10 Hz) caused the
    // network graph to repaint on every event — visible as the cursor
    // oscillating between pointer and arrow when hovering a node.
    let pending = false;
    const flush = (): void => {
      pending = false;
      setMessages(bufferRef.current);
    };
    return onMessagePublished((msg) => {
      // Drop framework-internal noise unless the user opted in. Otherwise a
      // peer-sync flood (snapshots/cursors/discovery, 2+ hubs) re-renders the
      // monitor every frame and can wedge the tab.
      if (isInfraTopic(msg.topic) && !showInfraRef.current) return;
      bufferRef.current = [...bufferRef.current.slice(-(MAX_MESSAGES - 1)), msg];
      if (pending) return;
      pending = true;
      requestAnimationFrame(flush);
    });
  }, []);

  const filterMessages = useCallback(
    (all: Message[]): Message[] => {
      let result = all;
      if (!showInfra) result = result.filter((m) => !isInfraTopic(m.topic));
      if (topicFilter) {
        result = result.filter((m) => m.topic.includes(topicFilter));
      }
      if (minCriticality > 0) {
        result = result.filter((m) => m.criticality >= minCriticality);
      }
      return result;
    },
    [topicFilter, minCriticality, showInfra],
  );

  return {
    messages: filterMessages(messages),
    loading,
    topicFilter,
    setTopicFilter,
    minCriticality,
    setMinCriticality,
    showInfra,
    setShowInfra,
  };
}
