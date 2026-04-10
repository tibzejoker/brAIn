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
    return onMessagePublished((msg) => {
      bufferRef.current = [...bufferRef.current.slice(-(MAX_MESSAGES - 1)), msg];
      setMessages(bufferRef.current);
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
