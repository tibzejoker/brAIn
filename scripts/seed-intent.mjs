#!/usr/bin/env node
/**
 * Helper for `pnpm dev:intent` — applies the `intent` seed (voice + gaze +
 * intent) once the API is up. Idempotent.
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
  const existing = await findByType("intent");
  if (existing) {
    console.log(`[seed-intent] intent node already live (${existing.id.slice(0, 8)}) — skipping seed.`);
  } else {
    console.log(`[seed-intent] applying seed "intent" (spawns voice + gaze + intent)…`);
    console.log(`[seed-intent] ${await applySeedByName("intent")}`);
  }

  console.log("[seed-intent] stack up:");
  console.log("[seed-intent]   dashboard         → http://localhost:5173");
  console.log("[seed-intent]   voice server      → http://localhost:8765");
  console.log("[seed-intent]   gaze server       → http://localhost:8766");
  console.log("[seed-intent]   intent (TS) API   → http://localhost:8767/api/persons");

  // Hold the process open. setInterval registers a libuv handle so Node
  // stays alive — `await new Promise(() => {})` alone is not enough.
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[seed-intent]", e);
  process.exit(1);
});
