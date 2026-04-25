#!/usr/bin/env node
/**
 * Helper for `pnpm start:attention` — once the brAIn API is up, posts the
 * `attention` seed if no nodes are already running. Idempotent: a second
 * run while attention + brain + chat are alive is a no-op.
 *
 * The script keeps the process alive afterwards so concurrently doesn't
 * tear the whole stack down. concurrently's --kill-others-on-fail is
 * intentionally left off so the api / dashboard panes stay up if the
 * seed fails.
 */
const API = `http://localhost:${process.env.API_PORT ?? "3000"}`;
const SEED_FILE = process.argv[2] ?? "./seeds/attention.yaml";

async function findByType(type) {
  const net = await fetch(`${API}/network`).then((r) => r.json());
  return (net?.nodes ?? []).find((n) => n.type === type) ?? null;
}

async function kickoff(attentionId, kickerNodeId) {
  // The bus filters out self-addressed messages (anti-loop), so we send
  // the bootstrap from another node — brain or chat from the seed —
  // on topic attention.* which the attention node subscribes to.
  const res = await fetch(`${API}/nodes/${kickerNodeId}/ui/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topic: "attention.boot", content: "bootstrap" }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[seed-attention] kickoff failed: ${res.status} ${body}`);
    return false;
  }
  console.log(`[seed-attention] kickoff sent (from ${kickerNodeId.slice(0,8)} → ${attentionId.slice(0,8)})`);
  return true;
}

async function applySeedByName(name) {
  // The seeds controller mounts at /network/seeds/:name/apply and
  // resolves the file from the configured seedsDir, which avoids the
  // "Seed file not found: ./seeds/..." trap when the api process'
  // cwd isn't the repo root.
  const res = await fetch(`${API}/network/seeds/${encodeURIComponent(name)}/apply`, {
    method: "POST",
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`apply seed: ${res.status} ${body}`);
  return body;
}

async function main() {
  // SEED_FILE may be a path or a name. Strip ./seeds/ + extension to get
  // the seed's logical name when needed.
  const seedName = SEED_FILE.replace(/^.*\//, "").replace(/\.ya?ml$/, "");

  const network = await fetch(`${API}/network`).then((r) => r.json());
  const nodeCount = Array.isArray(network?.nodes) ? network.nodes.length : 0;
  if (nodeCount > 0) {
    console.log(`[seed-attention] ${nodeCount} node(s) already live — skipping seed.`);
  } else {
    console.log(`[seed-attention] DB empty, applying seed "${seedName}"…`);
    const body = await applySeedByName(seedName);
    console.log(`[seed-attention] ${body}`);
  }

  // Wait briefly for the runtime to register subscriptions, then kick.
  await new Promise((r) => setTimeout(r, 500));
  const att = await findByType("attention");
  const kicker =
    (await findByType("brain")) ?? (await findByType("chat")) ?? null;
  if (att && kicker) {
    await kickoff(att.id, kicker.id);
  } else if (!att) {
    console.warn(`[seed-attention] no attention node found, skipping kickoff`);
  } else {
    console.warn(
      `[seed-attention] no other node to send kickoff from — attention will wait for real traffic`,
    );
  }
  // Hold the process so concurrently doesn't consider this pane "done".
  await new Promise(() => {});
}

main().catch((e) => {
  console.error("[seed-attention]", e);
  process.exit(1);
});
