export { Agent, AgentDirectory } from "./agent";
export type { AgentOptions, AgentAnnouncement } from "./agent";
// Re-export the announce constants from core for convenience — callers
// historically pulled them from @brain/agent's ANNOUNCE bundle.
export { AGENT_ANNOUNCE_TOPIC, AGENT_ANNOUNCE_DEFAULT_MS } from "@brain/core";
