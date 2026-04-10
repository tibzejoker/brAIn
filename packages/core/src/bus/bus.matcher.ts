/**
 * Matches a topic against a subscription pattern.
 *
 * Rules:
 * - Exact match: "alerts.audio" matches "alerts.audio"
 * - Wildcard suffix: "alerts.*" matches "alerts.audio", "alerts.audio.urgent", etc.
 * - Wildcard alone: "*" matches everything
 * - No wildcard: must be exact match
 */
export function matchTopic(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (pattern === "*") return true;

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // "alerts." from "alerts.*"
    return topic.startsWith(prefix);
  }

  return false;
}
