import { useState, useEffect, useRef, useCallback } from "react";
import type { Message } from "../api/types";
import { getMessages } from "../api/client";
import { onMessagePublished } from "../api/socket";

const MAX_MESSAGES = 500;

interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  topicFilter: string;
  setTopicFilter: (v: string) => void;
  minCriticality: number;
  setMinCriticality: (v: number) => void;
}

export function useMessages(): UseMessagesResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [topicFilter, setTopicFilter] = useState("");
  const [minCriticality, setMinCriticality] = useState(0);
  const bufferRef = useRef<Message[]>([]);

  useEffect(() => {
    getMessages({ last: 50 })
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
  }, []);

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
      bufferRef.current = [...bufferRef.current.slice(-(MAX_MESSAGES - 1)), msg];
      if (pending) return;
      pending = true;
      requestAnimationFrame(flush);
    });
  }, []);

  const filterMessages = useCallback(
    (all: Message[]): Message[] => {
      let result = all;
      if (topicFilter) {
        result = result.filter((m) => m.topic.includes(topicFilter));
      }
      if (minCriticality > 0) {
        result = result.filter((m) => m.criticality >= minCriticality);
      }
      return result;
    },
    [topicFilter, minCriticality],
  );

  return {
    messages: filterMessages(messages),
    loading,
    topicFilter,
    setTopicFilter,
    minCriticality,
    setMinCriticality,
  };
}
