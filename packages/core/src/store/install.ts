/**
 * Node-install helpers — clone+checkout, checksum verify, post-install
 * build. Pulled out of store.service.ts to keep that file under the
 * 300-line lint cap and so the supply-chain pieces are reviewable
 * in isolation.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "../logger";

/**
 * Clone the repo and check out exactly `ref`. `ref` may be a
 * branch, tag, or commit SHA. We first do a shallow clone of the
 * default branch (cheap), then `fetch + checkout` the requested
 * ref — works whether ref is a tag, branch, or any reachable SHA
 * the upstream allows fetching. Post-checkout we verify
 * `git rev-parse HEAD` matches the requested ref when ref is a
 * full SHA (40 hex chars), refusing any drift.
 */
export function cloneAndCheckout(cloneUrl: string, repoDir: string, ref: string): { error?: string } {
  const isFullSha = /^[0-9a-f]{40}$/.test(ref);
  // Neutralise Windows users' global `core.autocrlf=true` for every
  // git invocation here — the post-clone checksum verify hashes raw
  // file bytes, so CRLF rewriting would always mismatch.
  const NO_EOL_REWRITE = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];
  const r1 = spawnSync("git", [...NO_EOL_REWRITE, "clone", "--filter=blob:none", "--no-checkout", cloneUrl, repoDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r1.status !== 0) {
    const stderr = r1.stderr as Buffer | undefined;
    return { error: `git clone failed (${r1.status}): ${stderr ? stderr.toString() : ""}` };
  }
  const r2 = spawnSync("git", [...NO_EOL_REWRITE, "fetch", "--depth", "1", "origin", ref], {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r2.status !== 0) {
    const stderr = r2.stderr as Buffer | undefined;
    return { error: `git fetch ${ref} failed (${r2.status}): ${stderr ? stderr.toString() : ""}` };
  }
  const r3 = spawnSync("git", [...NO_EOL_REWRITE, "checkout", "FETCH_HEAD"], {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r3.status !== 0) {
    const stderr = r3.stderr as Buffer | undefined;
    return { error: `git checkout FETCH_HEAD failed (${r3.status}): ${stderr ? stderr.toString() : ""}` };
  }
  if (isFullSha) {
    const r4 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] });
    const head = (r4.stdout as Buffer | undefined)?.toString().trim();
    if (head !== ref) {
      return { error: `post-checkout HEAD (${head ?? "?"}) does not match registry ref (${ref})` };
    }
  }
  return {};
}

/**
 * In-place equivalent for the Update path: the repo dir already
 * exists, we just need to fast-forward (or jump) to the pinned ref.
 * Uses the same EOL-neutralising flags as cloneAndCheckout so file
 * hashes line up with the registry's checksums.
 */
export function fetchAndCheckout(repoDir: string, ref: string): { error?: string } {
  const NO_EOL_REWRITE = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];
  const r1 = spawnSync("git", [...NO_EOL_REWRITE, "fetch", "--depth", "1", "origin", ref], {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r1.status !== 0) {
    const stderr = r1.stderr as Buffer | undefined;
    return { error: `git fetch ${ref} failed (${r1.status}): ${stderr ? stderr.toString() : ""}` };
  }
  const r2 = spawnSync("git", [...NO_EOL_REWRITE, "checkout", "--force", "FETCH_HEAD"], {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r2.status !== 0) {
    const stderr = r2.stderr as Buffer | undefined;
    return { error: `git checkout FETCH_HEAD failed (${r2.status}): ${stderr ? stderr.toString() : ""}` };
  }
  return {};
}

/**
 * Walk the checksum manifest and return the first path that
 * doesn't match (or null if all clean). Missing files count as
 * mismatches — the manifest is the source of truth for what must
 * exist after a clean install.
 */
export function verifyChecksums(rootDir: string, checksums: Record<string, string>): string | null {
  for (const [rel, expected] of Object.entries(checksums)) {
    const abs = path.resolve(rootDir, rel);
    if (!abs.startsWith(path.resolve(rootDir) + path.sep) && abs !== path.resolve(rootDir)) {
      return `${rel} (escapes subpath)`;
    }
    if (!fs.existsSync(abs)) return `${rel} (missing)`;
    const buf = fs.readFileSync(abs);
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== expected) return `${rel} (got ${got.slice(0, 12)}…, expected ${expected.slice(0, 12)}…)`;
  }
  return null;
}

/**
 * Build the freshly-cloned sister so every node has its dist/ by
 * the time spawn() tries to import handler.js.
 *
 * `pnpm install` runs in the FRAMEWORK root, not in the cloned
 * repo — that way the cloned sister gets picked up via brAIn's
 * pnpm-workspace.yaml glob and `@brain/sdk: workspace:*` resolves
 * through the framework's own packages. Then `pnpm --dir <repo>
 * build` builds every sister-repo node.
 *
 * 5-minute hard timeout per command.
 */
export function installAndBuild(repoDir: string, frameworkRoot: string): string | null {
  logger.info({ repoDir, frameworkRoot }, "store: pnpm install + build (post-clone)");
  const inst = spawnSync("pnpm", ["install"], {
    cwd: frameworkRoot, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000,
  });
  if (inst.status !== 0) {
    const err = ((inst.stderr as Buffer | undefined)?.toString() ?? "")
      || ((inst.stdout as Buffer | undefined)?.toString() ?? "")
      || `exit ${inst.status ?? "?"}`;
    return `pnpm install (in ${frameworkRoot}): ${err.split("\n").slice(-3).join(" | ")}`;
  }
  const build = spawnSync("pnpm", ["--dir", repoDir, "-r", "build"], {
    cwd: frameworkRoot, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000,
  });
  if (build.status !== 0) {
    const err = ((build.stderr as Buffer | undefined)?.toString() ?? "")
      || ((build.stdout as Buffer | undefined)?.toString() ?? "")
      || `exit ${build.status ?? "?"}`;
    return `pnpm -r build (in ${repoDir}): ${err.split("\n").slice(-5).join(" | ")}`;
  }
  return null;
}
