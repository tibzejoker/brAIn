#!/usr/bin/env node
/**
 * brain-agent CLI - simple env-driven launcher.
 *
 * Required env:
 *   BRAIN_NATS_URL       e.g. nats://192.168.1.10:4222
 *
 * Optional:
 *   BRAIN_AGENT_ID       stable id (default: host-rand8)
 *   BRAIN_AGENT_HOST     friendly label (default: os.hostname())
 *   BRAIN_NATS_PREFIX    must match the API's prefix (default: brain)
 *   BRAIN_NATS_TOKEN     bearer token
 *   BRAIN_NODES_DIR      path-delimited list of dirs holding node types.
 *                        When unset, auto-discovers the framework's own
 *                        nodes/ AND every storeprojects/brAIn-/nodes/
 *                        sibling - matches the create-brain layout.
 *   BRAIN_DB_PATH        SQLite for restore (default: ./data/agent.db)
 *   BRAIN_AGENT_ANNOUNCE_MS   announce interval (default: 10000)
 */
import { Agent } from "./agent";
import * as fs from "node:fs";
import * as path from "node:path";

/*
 * Default node-dir discovery - mirrors the create-brain workspace:
 *
 *   brain/
 *     brAIn/             (framework - where this cli.js lives)
 *       packages/agent/dist/cli.js
 *       nodes/           (mostly _dynamic, included for completeness)
 *     storeprojects/
 *       brAIn-essentials/nodes/
 *       brAIn-games/nodes/
 *       ...
 *
 * Without this, a fresh remote agent runs against ./nodes (empty in a
 * HOME cwd) and announces zero installable types - the dashboard shows
 * "0 type" and labels it a passive bus client.
 */
function defaultNodesDirs(): string[] {
  // tsconfig is module=commonjs, so __dirname is available directly.
  // cli.js -> dist -> agent -> packages -> brAIn (framework root)
  const frameworkRoot = path.resolve(__dirname, "..", "..", "..");
  const dirs: string[] = [];
  const frameworkNodes = path.resolve(frameworkRoot, "nodes");
  if (fs.existsSync(frameworkNodes)) dirs.push(frameworkNodes);
  const storeprojectsRoot = path.resolve(frameworkRoot, "..", "storeprojects");
  if (fs.existsSync(storeprojectsRoot)) {
    for (const entry of fs.readdirSync(storeprojectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^brAIn-/i.test(entry.name)) continue;
      const candidate = path.join(storeprojectsRoot, entry.name, "nodes");
      if (fs.existsSync(candidate)) dirs.push(candidate);
    }
  }
  return dirs;
}

async function main(): Promise<void> {
  const natsUrl = process.env.BRAIN_NATS_URL;
  if (!natsUrl) {
    process.stderr.write("BRAIN_NATS_URL is required (e.g. nats://localhost:4222)\n");
    process.exit(2);
  }
  const envNodesDir = process.env.BRAIN_NODES_DIR;
  const nodesDir = envNodesDir
    ? envNodesDir.split(path.delimiter).filter(Boolean)
    : defaultNodesDirs();
  const agent = new Agent({
    natsUrl,
    natsPrefix: process.env.BRAIN_NATS_PREFIX,
    natsToken: process.env.BRAIN_NATS_TOKEN,
    agentId: process.env.BRAIN_AGENT_ID,
    host: process.env.BRAIN_AGENT_HOST,
    nodesDir,
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
