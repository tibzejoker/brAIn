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
  const repoDir = resolve(SIBLINGS_ROOT, node.repo);
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
function installAndBuild(repoDir) {
  process.stderr.write(`brain:   pnpm install (workspace)…\n`);
  const inst = spawnSync("pnpm", ["install"], {
    cwd: FRAMEWORK_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000,
  });
  if (inst.status !== 0) {
    return `pnpm install: ${(inst.stderr ?? "").toString().split("\n").slice(-3).join(" | ")}`;
  }
  process.stderr.write(`brain:   pnpm -r build (in ${path.basename(repoDir)})…\n`);
  const build = spawnSync("pnpm", ["--dir", repoDir, "-r", "build"], {
    cwd: FRAMEWORK_ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000,
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

function cmdPull(name) {
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
  const repoDir = resolve(SIBLINGS_ROOT, node.repo);
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
}

function usage() {
  process.stdout.write(
    "usage:\n"
    + "  pnpm brain list                — list marketplace nodes (installed + available)\n"
    + "  pnpm brain pull <node-name>    — install a node by short name\n"
    + "\n"
    + "Both commands work offline against the local brAIn-store clone.\n",
  );
}

switch (cmd) {
  case "list": cmdList(); break;
  case "pull": cmdPull(argv[1]); break;
  case "-h":
  case "--help":
  case undefined: usage(); break;
  default: die(`unknown command "${cmd}". Run \`brain --help\`.`);
}
