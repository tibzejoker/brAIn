#!/usr/bin/env node
/**
 * Helper for `pnpm dev:vocal-chat` — applies the `vocal-chat` seed
 * (voice + gaze + intent + attention + brain + chat) once the API is up.
 * Idempotent: skips re-seeding if a brain node is already live.
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
  const existing = await findByType("brain");
  if (existing) {
    console.log(`[seed-vocal-chat] brain node already live (${existing.id.slice(0, 8)}) — skipping seed.`);
  } else {
    console.log(`[seed-vocal-chat] applying seed "vocal-chat" (voice + gaze + intent + attention + brain + chat)…`);
    console.log(`[seed-vocal-chat] ${await applySeedByName("vocal-chat")}`);
  }

  console.log("[seed-vocal-chat] stack up:");
  console.log("[seed-vocal-chat]   dashboard         → http://localhost:5173");
  console.log("[seed-vocal-chat]   voice server      → http://localhost:8765");
  console.log("[seed-vocal-chat]   gaze server       → http://localhost:8766");
  console.log("[seed-vocal-chat]   intent (TS) API   → http://localhost:8767/api/persons");
  console.log("[seed-vocal-chat]   chat              → open the 'human' node UI in the dashboard");

  // Hold the process open so concurrently keeps the rest alive.
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[seed-vocal-chat]", e);
  process.exit(1);
});
