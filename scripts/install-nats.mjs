#!/usr/bin/env node
// Download the official `nats-server` Go binary for the current
// platform and place it under packages/core/bin/nats-server. The
// API spawns this binary at boot when no external BRAIN_NATS_URL
// is provided, so the framework runs out-of-the-box on a fresh
// clone without anyone installing NATS by hand.
//
// Skip cases:
//   - BRAIN_SKIP_NATS_DOWNLOAD=1  → caller manages NATS themselves
//   - BRAIN_NATS_URL set          → external broker, no embed needed
//   - binary already on disk      → idempotent
//
// Failure mode: log a warning and exit 0. The API will surface a
// clear error at boot if the binary is missing AND no external
// URL is set; we don't want a network blip during `pnpm install`
// to prevent the rest of postinstall (sdk + core build, store
// clone) from running.

import { existsSync, mkdirSync, createWriteStream, chmodSync, unlinkSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, "..");
const BIN_DIR = resolve(FRAMEWORK_ROOT, "packages/core/bin");

// Pinned for reproducibility. Bump version + checksums together.
const NATS_VERSION = "v2.14.0";
const SHA256 = {
  "darwin-arm64": "36f28cf166e5ae5dd88d700a609c810b97ffad641e0c51b49cf8fae25fb3fac7",
  "darwin-x64":   "c307afaa5810dea24bfe5bb0cd895ddc7c47946f359823336ef3be1a41bdddfa",
  "linux-x64":    "3d8b74dfad39af184c765a6dd120441ed1c648d6672eddf6b304f222661251b8",
  "linux-arm64":  "ce7dc5f7d97b70dabc38b13157fed28d7d06227860676143c15c62c5c297996c",
  "win32-x64":    "09ba382669cc4df390f97f16f08481f040eef0bb17ca5f2d71104b4be4cd613a",
};
const ASSET_NAME = {
  "darwin-arm64": "nats-server-v2.14.0-darwin-arm64.tar.gz",
  "darwin-x64":   "nats-server-v2.14.0-darwin-amd64.tar.gz",
  "linux-x64":    "nats-server-v2.14.0-linux-amd64.tar.gz",
  "linux-arm64":  "nats-server-v2.14.0-linux-arm64.tar.gz",
  "win32-x64":    "nats-server-v2.14.0-windows-amd64.zip",
};

function log(msg) { process.stderr.write(`install-nats: ${msg}\n`); }

if (process.env.BRAIN_SKIP_NATS_DOWNLOAD === "1") {
  log("skipped (BRAIN_SKIP_NATS_DOWNLOAD=1)");
  process.exit(0);
}
if (process.env.BRAIN_NATS_URL) {
  log(`skipped (external BRAIN_NATS_URL=${process.env.BRAIN_NATS_URL})`);
  process.exit(0);
}

const platformKey = `${process.platform}-${process.arch}`;
const asset = ASSET_NAME[platformKey];
const expectedSha = SHA256[platformKey];
if (!asset || !expectedSha) {
  log(`unsupported platform ${platformKey} — skipping. Set BRAIN_NATS_URL to use an external broker.`);
  process.exit(0);
}

const binaryName = process.platform === "win32" ? "nats-server.exe" : "nats-server";
const binaryPath = resolve(BIN_DIR, binaryName);

if (existsSync(binaryPath) && statSync(binaryPath).size > 0) {
  log(`already present at ${binaryPath}`);
  process.exit(0);
}

mkdirSync(BIN_DIR, { recursive: true });

const downloadUrl = `https://github.com/nats-io/nats-server/releases/download/${NATS_VERSION}/${asset}`;
const archivePath = resolve(BIN_DIR, asset);

try {
  log(`downloading ${asset} (${NATS_VERSION})…`);
  const res = await fetch(downloadUrl, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archivePath));

  // Verify checksum BEFORE extracting — bail early on tampered downloads.
  const hash = createHash("sha256");
  await pipeline((await import("node:fs")).createReadStream(archivePath), hash);
  const actualSha = hash.digest("hex");
  if (actualSha !== expectedSha) {
    unlinkSync(archivePath);
    throw new Error(`SHA256 mismatch for ${asset} — got ${actualSha}, expected ${expectedSha}`);
  }

  // Extract — `tar` for *.tar.gz on unix, PowerShell Expand-Archive for *.zip on win.
  if (asset.endsWith(".tar.gz")) {
    const r = spawnSync("tar", ["-xzf", archivePath, "-C", BIN_DIR, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("tar extraction failed");
  } else if (asset.endsWith(".zip")) {
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${BIN_DIR}'`],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error("zip extraction failed");
    // The zip extracts into a versioned subdir on Windows. Move the
    // exe up one level so the lookup path is stable.
    const subdir = asset.replace(/\.zip$/, "");
    const sourceExe = resolve(BIN_DIR, subdir, "nats-server.exe");
    if (existsSync(sourceExe)) {
      spawnSync("powershell", ["-NoProfile", "-Command", `Move-Item -Force '${sourceExe}' '${binaryPath}'`], { stdio: "inherit" });
    }
  }

  unlinkSync(archivePath);

  if (!existsSync(binaryPath)) {
    throw new Error(`extraction completed but ${binaryPath} not found`);
  }
  if (process.platform !== "win32") chmodSync(binaryPath, 0o755);

  log(`ok → ${binaryPath}`);
} catch (err) {
  log(`failed: ${err.message}`);
  log("framework will refuse to boot until either this binary is present or BRAIN_NATS_URL is set.");
  // exit 0 — don't break the rest of postinstall.
  process.exit(0);
}
