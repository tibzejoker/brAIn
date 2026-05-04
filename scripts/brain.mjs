#!/usr/bin/env node
// brain CLI — talk to the running API to list / pull marketplace
// nodes from a terminal. Lives at the root so `pnpm brain …`
// resolves; expects the API to be up (defaults to localhost:3000,
// override with BRAIN_API).
//
// Two commands, on purpose:
//   brain list                  — every node in the marketplace
//                                 with installed / available status
//   brain pull <node-name>      — install a node by short name
//
// Add a flag for seeds later if needed; staying minimal for now.

const API = process.env.BRAIN_API ?? "http://localhost:3000";
const argv = process.argv.slice(2);
const cmd = argv[0];

async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, opts);
  } catch (err) {
    die(`API unreachable at ${API} — start it with \`pnpm start\` first.\n  (${err.message})`);
  }
  const text = await res.text();
  if (!res.ok) die(`HTTP ${res.status} ${res.statusText}\n  ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function die(msg) {
  process.stderr.write(`brain: ${msg}\n`);
  process.exit(1);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function cmdList() {
  const nodes = await req("/store/nodes");
  if (!Array.isArray(nodes) || nodes.length === 0) {
    process.stderr.write("brain: marketplace registry empty.\n");
    return;
  }
  // Width-fit the name column.
  const w = Math.max(4, ...nodes.map((n) => n.name.length));
  process.stdout.write(`${pad("NAME", w)}  STATUS     REPO              DESCRIPTION\n`);
  for (const n of nodes) {
    const status = n.installed ? "installed" : "available";
    const desc = (n.description ?? "").replace(/\s+/g, " ").slice(0, 60);
    process.stdout.write(`${pad(n.name, w)}  ${pad(status, 9)}  ${pad(n.repo, 16)}  ${desc}\n`);
  }
}

async function cmdPull(name) {
  if (!name) die("usage: brain pull <node-name>\n  → see `brain list` for options.");
  // Resolve short name → package_name from the registry. The API's
  // /store/install only takes package_name, so we look it up first.
  const nodes = await req("/store/nodes");
  const node = nodes.find((n) => n.name === name);
  if (!node) die(`unknown node "${name}". Run \`brain list\` to see what's available.`);
  if (node.installed) {
    process.stdout.write(`brain: "${name}" already installed at ${node.install_path}\n`);
    return;
  }
  process.stderr.write(`brain: installing ${node.package_name} (${node.repo})…\n`);
  const r = await req("/store/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package_name: node.package_name }),
  });
  process.stdout.write(`brain: ${r.status} — ${r.message}\n`);
  if (r.cloned_to) process.stdout.write(`  cloned to ${r.cloned_to}\n`);
}

function usage() {
  process.stdout.write(
    "usage:\n"
    + "  pnpm brain list                — list marketplace nodes (installed + available)\n"
    + "  pnpm brain pull <node-name>    — install a node by short name\n"
    + "\n"
    + `Override the API URL with BRAIN_API (default ${API}).\n`,
  );
}

switch (cmd) {
  case "list":
    await cmdList();
    break;
  case "pull":
    await cmdPull(argv[1]);
    break;
  case "-h":
  case "--help":
  case undefined:
    usage();
    break;
  default:
    die(`unknown command "${cmd}". Run \`brain --help\`.`);
}
