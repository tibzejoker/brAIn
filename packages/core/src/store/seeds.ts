/**
 * Marketplace seed install — split out so store.service.ts stays
 * under the 300-line lint cap. Pulls a YAML by raw GitHub URL at
 * the registry's pinned ref, verifies the SHA-256, writes locally.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StoreRegistry, StoreRepo } from "./store.service";

export interface InstallSeedResult {
  status: "installed" | "failed";
  message: string;
  path?: string;
}

export async function installSeedYaml(
  reg: StoreRegistry,
  name: string,
  seedsDir: string,
): Promise<InstallSeedResult> {
  const seed = (reg.seeds ?? []).find((s) => s.name === name);
  if (!seed) return { status: "failed", message: `unknown seed: ${name}` };
  const repoMeta = reg.repos[seed.repo] as StoreRepo | undefined;
  if (!repoMeta) return { status: "failed", message: `seed references unknown repo: ${seed.repo}` };

  // Use raw GitHub URL when origin is GitHub — much cheaper than
  // cloning a whole repo just to read one YAML file.
  const ghMatch = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(repoMeta.clone);
  if (!ghMatch) {
    return { status: "failed", message: `non-github clone URL not yet supported for seed install: ${repoMeta.clone}` };
  }
  const rawUrl = `https://raw.githubusercontent.com/${ghMatch[1]}/${ghMatch[2]}/${seed.ref}/${seed.subpath}`;
  let yaml: string;
  try {
    const res = await fetch(rawUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { status: "failed", message: `GET ${rawUrl} → HTTP ${res.status}` };
    yaml = await res.text();
  } catch (err) {
    return { status: "failed", message: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const got = createHash("sha256").update(yaml).digest("hex");
  if (got !== seed.checksum) {
    return { status: "failed", message: `checksum mismatch (got ${got.slice(0, 12)}…, expected ${seed.checksum.slice(0, 12)}…)` };
  }
  if (!fs.existsSync(seedsDir)) fs.mkdirSync(seedsDir, { recursive: true });
  const dest = path.join(seedsDir, `${name}.yaml`);
  fs.writeFileSync(dest, yaml);
  return { status: "installed", message: `installed to ${dest}`, path: dest };
}
