#!/usr/bin/env node
/**
 * Helper for `pnpm dev:gaze` — applies the `gaze` seed once the API is up
 * (idempotent: skipped if any gaze node is already alive).
 */
const API = `http://localhost:${process.env.API_PORT ?? "3000"}`;

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
  const existing = await findByType("gaze");
  if (existing) {
    console.log(`[seed-gaze] gaze node already live (${existing.id.slice(0, 8)}) — skipping seed.`);
  } else {
    console.log(`[seed-gaze] applying seed "gaze"…`);
    console.log(`[seed-gaze] ${await applySeedByName("gaze")}`);
  }

  console.log("[seed-gaze] gaze node up — dashboard at http://localhost:5173");
  console.log("[seed-gaze] trigger cam capture without the web frontend:");
  console.log("[seed-gaze]   curl -X POST http://localhost:8766/api/capture/start -H 'content-type: application/json' -d '{\"device\":0,\"fps\":6}'");
  console.log("[seed-gaze]   curl http://localhost:8766/api/capture/preview.jpg -o preview.jpg");
  console.log("[seed-gaze]   curl -X POST http://localhost:8766/api/capture/stop");

  // Hold the process open so concurrently doesn't consider this pane "done"
  // and tear down the stack via --kill-others. `await new Promise(() => {})`
  // alone doesn't suffice — Node exits when libuv has no active handle.
  // setInterval registers one, so the loop stays alive until SIGTERM/SIGINT.
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[seed-gaze]", e);
  process.exit(1);
});
