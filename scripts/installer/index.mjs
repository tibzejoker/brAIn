#!/usr/bin/env node
// create-brain — bootstrap a brAIn dev workspace.
//
// Usage:
//   npm create brain [folder] [--no-install]
//   npx create-brain  [folder] [--no-install]
//
// Lays out:
//   <folder>/                  (default: ./brain)
//     brAIn/                   git clone tibzejoker/brAIn
//     brAIn-store/             git clone tibzejoker/brAIn-store
//     storeprojects/           empty — populated at runtime by `pnpm brain pull`
//
// Then runs `pnpm install` inside brAIn/ (which downloads the bundled
// nats-server binary and builds sdk/core/agent). Skipped with --no-install.
//
// Zero deps on purpose — stdlib only, runs anywhere Node 20+ runs.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPOS = {
  brAIn: "https://github.com/tibzejoker/brAIn.git",
  "brAIn-store": "https://github.com/tibzejoker/brAIn-store.git",
};

const IS_WIN = process.platform === "win32";

const c = {
  reset: "\x1b[0m",
  bold:  "\x1b[1m",
  dim:   "\x1b[2m",
  cyan:  "\x1b[36m",
  green: "\x1b[32m",
  red:   "\x1b[31m",
  yellow:"\x1b[33m",
};

const info = (m) => console.log(`${c.cyan}create-brain${c.reset} ${m}`);
const ok   = (m) => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = (m) => console.warn(`${c.yellow}!${c.reset} ${m}`);
const die  = (m) => { console.error(`${c.red}✗${c.reset} ${m}`); process.exit(1); };

function printHelp() {
  console.log(`
${c.bold}create-brain${c.reset} — bootstrap a brAIn dev workspace

Usage:
  npm create brain [folder] [options]
  npx create-brain [folder] [options]

Default: clone, install, AND launch (one command, end-to-end).

Options:
  --no-start      Stop after install — do not launch \`pnpm start\`
  --no-install    Skip the final \`pnpm install\` (implies --no-start)
  -h, --help      Show this help

Layout produced (default folder: ./brain):
  <folder>/
    brAIn/             framework (cloned)
    brAIn-store/       marketplace registry (cloned)
    storeprojects/     empty — populated by \`pnpm brain pull\` at runtime
`);
}

function parseArgs(argv) {
  const args = { folder: undefined, install: true, start: true };
  for (const a of argv) {
    if (a === "--no-install") args.install = false;
    else if (a === "--no-start") args.start = false;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else if (a.startsWith("-")) die(`unknown flag: ${a} (try --help)`);
    else if (args.folder === undefined) args.folder = a;
    else die(`unexpected positional arg: ${a}`);
  }
  if (args.folder === undefined) args.folder = "brain";
  // No install → no start (start needs the deps).
  if (!args.install) args.start = false;
  return args;
}

function nodeMajor() { return parseInt(process.versions.node.split(".")[0], 10); }

function canRun(cmd, args = ["--version"]) {
  // shell: true on Windows so .cmd shims (git, pnpm, corepack) resolve.
  const r = spawnSync(cmd, args, { stdio: "ignore", shell: IS_WIN });
  return r.status === 0;
}

function ensurePnpm() {
  if (canRun("pnpm")) return;
  info("pnpm not found — bootstrapping via corepack…");
  // Corepack ships with Node 20. `enable` may be a no-op on recent versions.
  spawnSync("corepack", ["enable"], { stdio: "inherit", shell: IS_WIN });
  const prep = spawnSync("corepack", ["prepare", "pnpm@latest", "--activate"], { stdio: "inherit", shell: IS_WIN });
  if (prep.status !== 0 || !canRun("pnpm")) {
    die("could not bootstrap pnpm via corepack. Install it manually: https://pnpm.io/installation");
  }
}

function gitClone(url, target) {
  // -c core.autocrlf=false -c core.eol=lf — matches brAIn/scripts/clone-store.mjs.
  // brAIn-store ships SHA-256-pinned files; CRLF rewriting on Windows would
  // break checksums. Harmless for the brAIn checkout itself.
  const r = spawnSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", url, target],
    { stdio: "inherit", shell: IS_WIN },
  );
  if (r.status !== 0) throw new Error(`git clone failed for ${url}`);
}

function isEmpty(dir) {
  try { return readdirSync(dir).length === 0; } catch { return true; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (nodeMajor() < 20) die(`Node 20+ required, you have ${process.versions.node}`);
  if (!canRun("git")) die("git not found in PATH. Install git: https://git-scm.com/downloads");

  const target = resolve(process.cwd(), args.folder);
  if (existsSync(target) && !isEmpty(target)) {
    die(`target ${target} exists and is not empty — pick a different folder or remove it.`);
  }

  info(`bootstrapping brAIn workspace in ${c.bold}${target}${c.reset}`);
  const created = [];

  try {
    if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
      created.push(target);
    }

    info("cloning brAIn (framework)…");
    const brainDir = resolve(target, "brAIn");
    gitClone(REPOS.brAIn, brainDir);
    created.push(brainDir);
    ok("brAIn cloned");

    info("cloning brAIn-store (marketplace registry)…");
    const storeDir = resolve(target, "brAIn-store");
    gitClone(REPOS["brAIn-store"], storeDir);
    created.push(storeDir);
    ok("brAIn-store cloned");

    info("creating empty storeprojects/ (filled at runtime via `pnpm brain pull`)");
    const projectsDir = resolve(target, "storeprojects");
    mkdirSync(projectsDir, { recursive: true });
    created.push(projectsDir);
    ok("storeprojects/ ready");

    if (args.install) {
      ensurePnpm();
      info("running `pnpm install` inside brAIn/ (downloads nats-server, builds sdk/core/agent)…");
      // BRAIN_NO_STORE_CLONE: postinstall would otherwise try to re-clone
      // brAIn-store next to brAIn — we already did it, skip the duplicate.
      const env = { ...process.env, BRAIN_NO_STORE_CLONE: "1" };
      const r = spawnSync("pnpm", ["install"], {
        cwd: brainDir,
        stdio: "inherit",
        shell: IS_WIN,
        env,
      });
      if (r.status !== 0) throw new Error("pnpm install failed");
      ok("dependencies installed");
    } else {
      warn("skipped `pnpm install` (--no-install). Run it yourself before launching:");
      console.log(`    cd ${args.folder}/brAIn && pnpm install`);
    }
  } catch (err) {
    console.error(`\n${c.red}✗ install failed:${c.reset} ${err.message}`);
    if (created.length > 0) {
      info("rolling back partial install…");
      for (const d of created.reverse()) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
    process.exit(1);
  }

  const launcher = IS_WIN ? "run.cmd" : "./run";

  if (args.start) {
    // Auto-launch: hand off to `pnpm start`. The installer becomes a
    // long-running launcher — Ctrl+C from the user kills the chain.
    console.log(`
${c.green}${c.bold}✓ brAIn workspace ready — launching${c.reset}

API:        ${c.bold}http://localhost:3000${c.reset}
Dashboard:  ${c.bold}http://localhost:5173${c.reset}  ${c.dim}← open in your browser once both are up${c.reset}

${c.dim}First boot takes ~1 min: the auto-seed clones a few sister repos.${c.reset}
${c.dim}Pass --no-start next time if you'd rather launch manually with \`${launcher}\`.${c.reset}
`);
    const r = spawnSync("pnpm", ["start"], {
      cwd: resolve(process.cwd(), args.folder, "brAIn"),
      stdio: "inherit",
      shell: IS_WIN,
    });
    process.exit(r.status ?? 0);
  }

  console.log(`
${c.green}${c.bold}✓ brAIn workspace ready${c.reset}

Next steps:
  ${c.cyan}cd ${args.folder}/brAIn${c.reset}
  ${c.cyan}${launcher}${c.reset}

API:        ${c.bold}http://localhost:3000${c.reset}
Dashboard:  ${c.bold}http://localhost:5173${c.reset}

Add nodes from the Marketplace tab in the dashboard,
or via CLI:  ${c.cyan}pnpm brain pull <name>${c.reset}
`);
}

main();
