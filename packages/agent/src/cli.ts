#!/usr/bin/env node
/**
 * `brain-agent` CLI — simple env-driven launcher.
 *
 * Required env:
 *   BRAIN_NATS_URL       e.g. nats://192.168.1.10:4222
 *
 * Optional:
 *   BRAIN_AGENT_ID       stable id (default: <host>-<rand8>)
 *   BRAIN_AGENT_HOST     friendly label (default: os.hostname())
 *   BRAIN_NATS_PREFIX    must match the API's prefix (default: brain)
 *   BRAIN_NATS_TOKEN     bearer token
 *   BRAIN_NODES_DIR      where node types live (default: ./nodes)
 *   BRAIN_DB_PATH        SQLite for restore (default: ./data/agent.db)
 *   BRAIN_AGENT_ANNOUNCE_MS   announce interval (default: 10000)
 */
import { Agent } from "./agent";
import * as path from "node:path";

async function main(): Promise<void> {
  const natsUrl = process.env.BRAIN_NATS_URL;
  if (!natsUrl) {
    process.stderr.write("BRAIN_NATS_URL is required (e.g. nats://localhost:4222)\n");
    process.exit(2);
  }
  const agent = new Agent({
    natsUrl,
    natsPrefix: process.env.BRAIN_NATS_PREFIX,
    natsToken: process.env.BRAIN_NATS_TOKEN,
    agentId: process.env.BRAIN_AGENT_ID,
    host: process.env.BRAIN_AGENT_HOST,
    nodesDir: process.env.BRAIN_NODES_DIR
      ?? path.resolve(process.cwd(), "nodes"),
    dbPath: process.env.BRAIN_DB_PATH
      ?? path.resolve(process.cwd(), "data", "agent.db"),
    announceIntervalMs: process.env.BRAIN_AGENT_ANNOUNCE_MS
      ? Number(process.env.BRAIN_AGENT_ANNOUNCE_MS)
      : undefined,
  });
  await agent.start();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`brain-agent: ${msg}\n`);
  process.exit(1);
});
