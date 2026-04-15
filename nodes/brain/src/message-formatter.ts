/**
 * Topic routing & content formatting for brain → service communication.
 *
 * Two layers:
 *   1. Static aliases — redirect known wrong topics (e.g. memory.store → mem.store)
 *   2. Dynamic response mapping — built from live network subscriptions
 */
import { BrainService } from "@brain/core";

export interface TopicRoute {
  topic: string;
  format(content: string): string;
  responseTopic: string;
  timeout: number;
}

// --- Static aliases: topics the LLM commonly gets wrong ---
const TOPIC_ALIASES: Record<string, string> = {
  "memory.store":  "mem.store",
  "memory.search": "mem.ask",
  "memory.recall": "mem.ask",
};

// --- Response topic discovery from live network ---
// Maps input topic → {responseTopic, timeout} by scanning node subscriptions + publishes

function discoverResponseTopic(topic: string): { responseTopic: string; timeout: number } | null {
  const brain = BrainService.current
    ?? (globalThis as Record<string, unknown>).__brainService as BrainService | undefined;
  if (!brain) return null;

  // Find a node subscribed to this topic
  const nodes = brain.getNetworkSnapshot({ state: "all" });
  for (const node of nodes) {
    const subs = brain.bus.getSubscriptions(node.id);
    const matches = subs.some((s) => s.pattern === topic || (s.pattern.endsWith(".*") && topic.startsWith(s.pattern.slice(0, -2))));
    if (!matches) continue;

    // Check the node's config for a response_topic
    const overrides = node.config_overrides ?? {};
    const responseTopic = overrides.response_topic as string | undefined;
    if (responseTopic) {
      // LLM nodes are slower
      const isLLM = node.tags.includes("llm");
      return { responseTopic, timeout: isLLM ? 30_000 : 10_000 };
    }

    // Infer from type config default_publishes
    const typeConfig = brain.typeRegistry.get(node.type);
    if (typeConfig?.default_publishes?.length) {
      return {
        responseTopic: typeConfig.default_publishes[0],
        timeout: node.tags.includes("llm") ? 30_000 : 10_000,
      };
    }
  }
  return null;
}

function asIs(content: string): string {
  return content;
}

/**
 * Resolve a topic to its route.
 * Applies aliases, discovers response topics dynamically from the live network.
 */
export function resolveRoute(rawTopic: string): TopicRoute {
  const topic = (TOPIC_ALIASES[rawTopic] as string | undefined) ?? rawTopic;
  const response = discoverResponseTopic(topic);

  return {
    topic,
    format: asIs,
    responseTopic: response?.responseTopic ?? "",
    timeout: response?.timeout ?? 0,
  };
}
