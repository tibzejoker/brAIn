#!/usr/bin/env node
/**
 * Helper for `pnpm start:voice` — once the brAIn API is up, applies the
 * `voice` seed (idempotent: skipped if any voice node is already alive).
 *
 * The seed spawns a single voice node, whose onSpawn hook boots the
 * Python child (uvicorn on 8765). Killing the node from the dashboard
 * or via `DELETE /nodes/:id` SIGTERMs the child cleanly.
 *
 * The script keeps the process alive after seeding so concurrently
 * doesn't consider this pane "done" and tear the stack down.
 */
const API = `http://localhost:${process.env.API_PORT ?? "3000"}`;
const SEED_NAME = "voice";

async function findByType(type) {
  const net = await fetch(`${API}/network`).then((r) => r.json());
  return (net?.nodes ?? []).find((n) => n.type === type) ?? null;
}

async function applySeedByName(name) {
  const res = await fetch(`${API}/network/seeds/${encodeURIComponent(name)}/apply`, {
    method: "POST",
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`apply seed: ${res.status} ${body}`);
  return body;
}

async function main() {
  const existing = await findByType("voice");
  if (existing) {
    console.log(`[seed-voice] voice node already live (${existing.id.slice(0, 8)}) — skipping seed.`);
  } else {
    console.log(`[seed-voice] applying seed "${SEED_NAME}"…`);
    const body = await applySeedByName(SEED_NAME);
    console.log(`[seed-voice] ${body}`);
  }

  console.log("[seed-voice] voice node up — dashboard at http://localhost:5173");
  console.log("[seed-voice] trigger mic capture without the web frontend:");
  console.log("[seed-voice]   curl -X POST http://localhost:8765/api/capture/start -H 'content-type: application/json' -d '{}'");
  console.log("[seed-voice]   curl -X POST http://localhost:8765/api/capture/stop");

  // Hold the process open so concurrently doesn't consider this pane "done"
  // and tear down the stack via --kill-others. `await new Promise(() => {})`
  // alone doesn't suffice — Node exits when libuv has no active handle.
  // setInterval registers one, so the loop stays alive until SIGTERM/SIGINT.
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[seed-voice]", e);
  process.exit(1);
});
