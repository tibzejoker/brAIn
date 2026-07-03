#!/usr/bin/env node
// brain CLI — list / pull marketplace nodes from a terminal.
// Lives at the root so `pnpm brain …` resolves.
//
// 100% offline. Both commands work without the brAIn API running —
// the use case is bootstrapping a remote brain-agent on a machine
// that doesn't (and shouldn't) boot the full framework. They mirror
// what StoreService does on the server side: registry lookup, git
// clone at pinned ref, per-file SHA-256 verify, pnpm install +
// build. The only difference is no in-process type-registry
// refresh — irrelevant when the framework isn't running.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(HERE, "..");
const SIBLINGS_ROOT = resolve(FRAMEWORK_ROOT, "..");
const REGISTRY_PATH = resolve(SIBLINGS_ROOT, "brAIn-store", "registry.json");
// Where node bundles live. "grouped" layout: SIBLINGS_ROOT/storeprojects/.
// Falls back to SIBLINGS_ROOT (flat layout) for backward compat.
const STOREPROJECTS = resolve(SIBLINGS_ROOT, "storeprojects");
const BUNDLES_ROOT = fs.existsSync(STOREPROJECTS) ? STOREPROJECTS : SIBLINGS_ROOT;

const argv = process.argv.slice(2);
const cmd = argv[0];

function die(msg) {
  process.stderr.write(`brain: ${msg}\n`);
  process.exit(1);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function readRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    die(`registry not found at ${REGISTRY_PATH}.\n  Run \`pnpm install\` to clone brAIn-store.`);
  }
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
}

/** True when the parent repo is cloned and the node's subpath has a config.json. */
function isInstalled(node) {
  const repoDir = resolve(BUNDLES_ROOT, node.repo);
  if (!existsSync(repoDir)) return false;
  return existsSync(resolve(repoDir, node.subpath, "config.json"));
}

// === Pull primitives — ported from packages/core/src/store/install.ts ===

function cloneAndCheckout(cloneUrl, repoDir, ref) {
  const isFullSha = /^[0-9a-f]{40}$/.test(ref);
  const r1 = spawnSync("git", ["clone", "--filter=blob:none", "--no-checkout", cloneUrl, repoDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r1.status !== 0) return `git clone failed: ${(r1.stderr ?? "").toString().trim()}`;
  const r2 = spawnSync("git", ["fetch", "--depth", "1", "origin", ref], {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r2.status !== 0) return `git fetch ${ref} failed: ${(r2.stderr ?? "").toString().trim()}`;
  const r3 = spawnSync("git", ["checkout", "FETCH_HEAD"], {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r3.status !== 0) return `git checkout FETCH_HEAD failed: ${(r3.stderr ?? "").toString().trim()}`;
  if (isFullSha) {
    const r4 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const head = (r4.stdout ?? "").toString().trim();
    if (head !== ref) return `post-checkout HEAD (${head}) does not match registry ref (${ref})`;
  }
  return null;
}

/** Returns the first checksum-mismatching file, or null when clean. */
function verifyChecksums(rootDir, checksums) {
  for (const [rel, expected] of Object.entries(checksums)) {
    const abs = path.resolve(rootDir, rel);
    if (!abs.startsWith(path.resolve(rootDir) + path.sep) && abs !== path.resolve(rootDir)) {
      return `${rel} (escapes subpath)`;
    }
    if (!fs.existsSync(abs)) return `${rel} (missing)`;
    const got = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    if (got !== expected) return `${rel} (got ${got.slice(0, 12)}…, expected ${expected.slice(0, 12)}…)`;
  }
  return null;
}

/** pnpm install in the framework root + pnpm -r build in the cloned repo. */
// shell: true on Windows — pnpm resolves to a .cmd shim there, which Node
// refuses to spawnSync directly (status null, empty stderr, so the pull
// failed with a blank error). Same treatment as the create-brain installer.
const PNPM_SHELL = process.platform === "win32";

function installAndBuild(repoDir) {
  process.stderr.write(`brain:   pnpm install (workspace)…\n`);
  const inst = spawnSync("pnpm", ["install"], {
    cwd: FRAMEWORK_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000, shell: PNPM_SHELL,
  });
  if (inst.status !== 0) {
    return `pnpm install: ${(inst.stderr ?? "").toString().split("\n").slice(-3).join(" | ")}`;
  }
  process.stderr.write(`brain:   pnpm -r build (in ${path.basename(repoDir)})…\n`);
  const build = spawnSync("pnpm", ["--dir", repoDir, "-r", "build"], {
    cwd: FRAMEWORK_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000, shell: PNPM_SHELL,
  });
  if (build.status !== 0) {
    return `pnpm -r build: ${(build.stderr ?? "").toString().split("\n").slice(-5).join(" | ")}`;
  }
  return null;
}

// === Commands ===

function cmdList() {
  const reg = readRegistry();
  const nodes = reg.nodes ?? [];
  if (nodes.length === 0) { process.stderr.write("brain: marketplace registry has no nodes.\n"); return; }
  const w = Math.max(4, ...nodes.map((n) => n.name.length));
  process.stdout.write(`${pad("NAME", w)}  STATUS     REPO              DESCRIPTION\n`);
  for (const n of nodes) {
    const status = isInstalled(n) ? "installed" : "available";
    const desc = (n.description ?? "").replace(/\s+/g, " ").slice(0, 60);
    process.stdout.write(`${pad(n.name, w)}  ${pad(status, 9)}  ${pad(n.repo, 16)}  ${desc}\n`);
  }
}

async function cmdPull(name) {
  if (!name) die("usage: brain pull <node-name>\n  → see `brain list` for options.");
  const reg = readRegistry();
  const node = (reg.nodes ?? []).find((n) => n.name === name);
  if (!node) die(`unknown node "${name}". Run \`brain list\` to see what's available.`);
  if (isInstalled(node)) {
    process.stdout.write(`brain: "${name}" already installed (${node.repo}/${node.subpath})\n`);
    return;
  }
  const repo = reg.repos?.[node.repo];
  if (!repo) die(`registry inconsistency: node "${name}" references unknown repo "${node.repo}"`);
  const repoDir = resolve(BUNDLES_ROOT, node.repo);
  const ref = node.ref ?? repo.default_branch ?? "main";

  process.stderr.write(`brain: cloning ${repo.clone} @ ${ref.slice(0, 12)}…\n`);
  const cloneErr = cloneAndCheckout(repo.clone, repoDir, ref);
  if (cloneErr) die(cloneErr);

  if (node.checksums) {
    process.stderr.write(`brain:   verifying ${Object.keys(node.checksums).length} file checksums…\n`);
    const subpathDir = resolve(repoDir, node.subpath);
    const bad = verifyChecksums(subpathDir, node.checksums);
    if (bad) die(`checksum mismatch: ${bad}`);
  }

  const buildErr = installAndBuild(repoDir);
  if (buildErr) die(buildErr);

  process.stdout.write(`brain: installed "${name}" → ${repoDir}\n`);
  process.stdout.write(`  subpath: ${node.subpath}\n`);
  if (node.needs_python) process.stdout.write(`  needs python — see ${node.repo}'s README\n`);
  if (node.needs_ollama) process.stdout.write(`  needs ollama running locally\n`);
  await notifyApiRescan();
}

/**
 * Tell a running API to register the freshly-installed node types — the
 * CLI installs on disk, outside the API's own install path, so without
 * this a live stack can't spawn the new types until the next restart.
 * Best-effort: when the stack is down, boot-time discovery covers it.
 */
async function notifyApiRescan() {
  const api = `http://localhost:${process.env.API_PORT ?? "3000"}`;
  try {
    const res = await fetch(`${api}/store/rescan`, {
      method: "POST", signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      const n = body?.new_types ?? 0;
      process.stdout.write(`  live API rescanned (${n} new type${n === 1 ? "" : "s"} registered)\n`);
    }
  } catch {
    process.stdout.write(`  (stack not running — types will register at next boot)\n`);
  }
}

function cmdRemove(name, yes) {
  if (!name) die("usage: brain remove <node-or-seed-name> [--yes]");
  const reg = readRegistry();
  // Try seed first — they're files, the cleanup is harmless.
  const seedPath = resolve(FRAMEWORK_ROOT, "seeds", `${name}.yaml`);
  if (fs.existsSync(seedPath)) {
    fs.unlinkSync(seedPath);
    process.stdout.write(`brain: removed seed "${name}" (${seedPath})\n`);
    return;
  }
  const node = (reg.nodes ?? []).find((n) => n.name === name);
  if (!node) die(`unknown node or seed "${name}".`);
  if (!isInstalled(node)) {
    process.stdout.write(`brain: "${name}" is not installed — nothing to remove.\n`);
    return;
  }
  // Removal is repo-level: nodes share their parent repo, so nuking
  // one means nuking the others. List the casualties up front and
  // require --yes when there's more than one.
  const repoDir = resolve(BUNDLES_ROOT, node.repo);
  const siblings = (reg.nodes ?? []).filter((n) => n.repo === node.repo);
  if (siblings.length > 1 && !yes) {
    process.stderr.write(`brain: "${name}" lives in ${node.repo}, which also contains:\n`);
    for (const s of siblings) {
      if (s.name === name) continue;
      process.stderr.write(`  - ${s.name}\n`);
    }
    process.stderr.write(`\nRemoving deletes the whole repo. Re-run with --yes to confirm.\n`);
    process.exit(1);
  }
  fs.rmSync(repoDir, { recursive: true, force: true });
  process.stdout.write(`brain: removed ${node.repo} (${siblings.length} node${siblings.length === 1 ? "" : "s"})\n`);
}

// Walk the local sibling clone of each registry entry and recompute its
// `ref` (current HEAD SHA) + `checksums` (SHA-256 of every file currently
// listed). Used to "promote" local dev commits into the marketplace —
// writes the new `registry.json` ONLY when `--write` is passed; otherwise
// prints a per-repo diff so the user can sanity-check before committing.
function cmdRefreshRegistry(write) {
  if (!fs.existsSync(REGISTRY_PATH)) {
    die(`registry not found at ${REGISTRY_PATH}.`);
  }
  const raw = readFileSync(REGISTRY_PATH, "utf-8");
  const reg = JSON.parse(raw);
  const nodes = reg.nodes ?? [];
  if (nodes.length === 0) {
    process.stdout.write("brain: registry has no nodes — nothing to refresh.\n");
    return;
  }

  // Group by repo so each git rev-parse only runs once. Per-node we still
  // re-hash all files because `checksums` is per-node (subpath-scoped).
  const headByRepo = new Map();
  function headOf(repoName) {
    if (headByRepo.has(repoName)) return headByRepo.get(repoName);
    const repoDir = resolve(BUNDLES_ROOT, repoName);
    if (!fs.existsSync(resolve(repoDir, ".git"))) {
      headByRepo.set(repoName, null);
      return null;
    }
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const sha = r.status === 0 ? (r.stdout ?? "").toString().trim() : null;
    headByRepo.set(repoName, sha);
    return sha;
  }

  let touched = 0;
  let skipped = 0;
  const missingRepos = new Set();
  const missingFiles = [];

  for (const node of nodes) {
    const newRef = headOf(node.repo);
    if (!newRef) {
      missingRepos.add(node.repo);
      skipped++;
      continue;
    }
    const subpathDir = resolve(BUNDLES_ROOT, node.repo, node.subpath);
    if (!fs.existsSync(subpathDir)) {
      missingRepos.add(`${node.repo}/${node.subpath}`);
      skipped++;
      continue;
    }

    // Re-hash every file currently in `checksums`. Files that have
    // disappeared upstream are flagged but kept in the output (dropping
    // entries is an explicit publish decision, not something to do here).
    const oldRef = node.ref ?? null;
    const oldChecksums = node.checksums ?? {};
    const newChecksums = {};
    let filesChanged = 0;
    for (const rel of Object.keys(oldChecksums)) {
      const abs = path.resolve(subpathDir, rel);
      if (!fs.existsSync(abs)) {
        missingFiles.push(`${node.name}/${rel}`);
        newChecksums[rel] = oldChecksums[rel];  // keep stale entry so registry stays parseable
        continue;
      }
      const got = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
      newChecksums[rel] = got;
      if (got !== oldChecksums[rel]) filesChanged++;
    }

    const refChanged = oldRef !== newRef;
    if (!refChanged && filesChanged === 0) {
      // Already up to date — leave entry untouched.
      continue;
    }
    touched++;
    process.stdout.write(
      `  ${pad(node.name, 24)}  ${oldRef ? oldRef.slice(0, 8) : "—"} → ${newRef.slice(0, 8)}  (${filesChanged} file${filesChanged === 1 ? "" : "s"} re-hashed)\n`,
    );
    if (write) {
      node.ref = newRef;
      node.checksums = newChecksums;
    }
  }

  if (missingRepos.size > 0) {
    process.stderr.write(`brain: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} — missing local clones:\n`);
    for (const r of missingRepos) process.stderr.write(`  - ${r}\n`);
  }
  if (missingFiles.length > 0) {
    process.stderr.write(`brain: ${missingFiles.length} files listed in checksums but missing upstream (kept stale):\n`);
    for (const f of missingFiles.slice(0, 10)) process.stderr.write(`  - ${f}\n`);
    if (missingFiles.length > 10) process.stderr.write(`  … and ${missingFiles.length - 10} more\n`);
  }

  if (touched === 0) {
    process.stdout.write("brain: registry already in sync with every local sibling.\n");
    return;
  }
  if (!write) {
    process.stdout.write(`\nbrain: ${touched} entr${touched === 1 ? "y" : "ies"} would change. Re-run with --write to apply.\n`);
    return;
  }
  // Preserve trailing newline + indentation style of the existing file
  // so the diff in `brAIn-store` stays clean.
  reg.updated_at = new Date().toISOString().slice(0, 10);
  const out = JSON.stringify(reg, null, 2) + "\n";
  fs.writeFileSync(REGISTRY_PATH, out);
  process.stdout.write(`\nbrain: wrote ${touched} updated entr${touched === 1 ? "y" : "ies"} to ${REGISTRY_PATH}\n`);
  process.stdout.write(`  next step: cd ${path.dirname(REGISTRY_PATH)} && git add registry.json && git commit -m "chore(registry): refresh refs + checksums"\n`);
}

function usage() {
  process.stdout.write(
    "usage:\n"
    + "  pnpm brain list                       — list marketplace nodes (installed + available)\n"
    + "  pnpm brain pull <node-name>           — install a node by short name\n"
    + "  pnpm brain remove <name> [--yes]      — uninstall a node or delete a local seed\n"
    + "  pnpm brain refresh-registry [--write] — recompute ref + checksums in brAIn-store/registry.json\n"
    + "                                          against local sibling HEADs (dry-run by default)\n"
    + "\n"
    + "All commands work offline against the local brAIn-store clone.\n",
  );
}

switch (cmd) {
  case "list": cmdList(); break;
  case "pull": await cmdPull(argv[1]); break;
  case "remove": cmdRemove(argv[1], argv.includes("--yes")); break;
  case "refresh-registry": cmdRefreshRegistry(argv.includes("--write")); break;
  case "-h":
  case "--help":
  case undefined: usage(); break;
  default: die(`unknown command "${cmd}". Run \`brain --help\`.`);
}
