/**
 * Shared helper: discover every storeprojects node-directory dynamically.
 *
 * Tests that spin up a BrainService usually need most or all of the
 * built-in node catalog (clock, brain, echo, memory, llm-basic, …).
 * After the split out of the monorepo into separate storeprojects/
 * repos, the path moved from `./nodes/<type>/` to
 * `storeprojects/brAIn-<area>/nodes/<type>/`. This helper scans
 * `storeprojects/` at runtime and returns every directory that looks
 * like a node-catalog (i.e. `<some-brain-repo>/nodes/`). Adding a new
 * area to the workspace? It's picked up automatically — no edit here.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const STOREPROJECTS_ROOT = path.resolve(__dirname, "..", "..", "..", "storeprojects");

export function allStoreprojectNodeDirs(): string[] {
  if (!fs.existsSync(STOREPROJECTS_ROOT)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(STOREPROJECTS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // Only accept entries that look like a brAIn storeproject — the
    // naming convention is `brAIn-<area>/`. This filters out incidental
    // siblings like `data/nodes` (a runtime artefact, not a catalog).
    if (!/^brAIn-/i.test(entry.name)) continue;
    const candidate = path.join(STOREPROJECTS_ROOT, entry.name, "nodes");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      out.push(candidate);
    }
  }
  return out.sort();
}
