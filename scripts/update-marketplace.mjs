#!/usr/bin/env node
// Trigger the marketplace's `refresh-registry` workflow on brAIn-store
// from a one-liner. The actual push to main happens server-side inside
// the workflow — this script just dispatches it and (optionally) tails
// the run.
//
// Auth: piggybacks on `gh` CLI auth, which the user already has set up
// for every other GitHub op in this project. No PAT in .env needed —
// the workflow uses its own MARKETPLACE_PUSH_TOKEN secret server-side.
//
// Config: optional overrides in .env at the framework root:
//   MARKETPLACE_REPO=tibzejoker/brAIn-store
//   MARKETPLACE_WORKFLOW=refresh-registry.yml
//
// Usage:
//   pnpm update-marketplace            # trigger + wait for completion
//   pnpm update-marketplace --no-wait  # trigger and return immediately

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(HERE, "..");

// Tiny .env loader — sufficient for KEY=value with optional quoting.
// We don't want to drag dotenv into a CLI script that runs maybe twice
// a week.
const envPath = resolve(FRAMEWORK_ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

const REPO = process.env.MARKETPLACE_REPO || "tibzejoker/brAIn-store";
const WORKFLOW = process.env.MARKETPLACE_WORKFLOW || "refresh-registry.yml";
const waitForRun = !process.argv.includes("--no-wait");

function gh(args, opts = {}) {
  return spawnSync("gh", args, { stdio: "inherit", ...opts });
}

process.stderr.write(`marketplace: dispatching ${WORKFLOW} on ${REPO}…\n`);
const dispatch = gh(["workflow", "run", WORKFLOW, "-R", REPO]);
if (dispatch.status !== 0) {
  process.stderr.write(`marketplace: dispatch failed. Is \`gh\` logged in to tibzejoker?\n`);
  process.exit(dispatch.status ?? 1);
}

if (!waitForRun) {
  process.stderr.write(`marketplace: triggered. Watch with \`gh run list -R ${REPO} --workflow=${WORKFLOW}\`.\n`);
  process.exit(0);
}

// Brief pause so the run actually shows up in the list before we query.
await new Promise((r) => setTimeout(r, 2500));

const list = spawnSync(
  "gh",
  ["run", "list", "-R", REPO, "--workflow", WORKFLOW, "--limit", "1", "--json", "databaseId,status"],
  { encoding: "utf-8" },
);
if (list.status !== 0) {
  process.stderr.write(`marketplace: cannot fetch the run id — tail manually.\n`);
  process.exit(0);
}
const runs = JSON.parse(list.stdout || "[]");
const runId = runs[0]?.databaseId;
if (!runId) {
  process.stderr.write(`marketplace: triggered, but couldn't find the run — check Actions tab.\n`);
  process.exit(0);
}

process.stderr.write(`marketplace: watching run ${runId}…\n`);
const watch = gh(["run", "watch", String(runId), "-R", REPO, "--exit-status"]);
process.exit(watch.status ?? 0);
