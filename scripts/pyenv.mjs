#!/usr/bin/env node
/**
 * Cross-platform helper for the Python services (voice, gaze, intent).
 *
 * Replaces the Linux-only inline `python3.11 -m venv` / `.venv/bin/<tool>`
 * commands in package.json so the same scripts work on Windows where venvs
 * live under `Scripts\` and the only reliable Python launcher is `py`.
 *
 *   node scripts/pyenv.mjs setup <pkg-dir> [--with-models]
 *     - creates server/.venv if missing
 *     - upgrades pip, installs server/requirements.txt
 *     - runs `python -m app.setup_models` if --with-models
 *     - runs `npm install` in web/ if a package.json is there
 *
 *   node scripts/pyenv.mjs run <pkg-dir> -- [KEY=VAL ...] <tool> [args...]
 *     - executes server/.venv/<bin>/<tool> with cwd = server/
 *     - leading KEY=VAL pairs are added to the child env
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const isWin = process.platform === "win32";
const VENV_BIN = isWin ? "Scripts" : "bin";

function findSystemPython() {
  const candidates = isWin
    ? [["py", "-3.11"], ["py", "-3.12"], ["py", "-3"], ["python"]]
    : [["python3.11"], ["python3.12"], ["python3"], ["python"]];
  for (const cmd of candidates) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { stdio: "ignore", shell: false });
    if (r.status === 0) return cmd;
  }
  throw new Error("No Python interpreter found (tried: " + candidates.map((c) => c.join(" ")).join(", ") + ")");
}

function venvExe(serverDir, tool) {
  const ext = isWin ? ".exe" : "";
  return path.resolve(serverDir, ".venv", VENV_BIN, tool + ext);
}

function runOrFail(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")} ${opts.cwd ? `(cwd=${opts.cwd})` : ""}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function cmdSetup(pkgDir, withModels) {
  const serverDir = path.join(pkgDir, "server");
  const venvDir = path.join(serverDir, ".venv");
  const py = venvExe(serverDir, "python");

  if (!existsSync(venvDir)) {
    const sysPy = findSystemPython();
    runOrFail(sysPy[0], [...sysPy.slice(1), "-m", "venv", ".venv"], { cwd: serverDir });
  }

  runOrFail(py, ["-m", "pip", "install", "-U", "pip"], { cwd: serverDir });
  runOrFail(py, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: serverDir });

  if (withModels) {
    runOrFail(py, ["-m", "app.setup_models"], { cwd: serverDir });
  }

  const webDir = path.join(pkgDir, "web");
  if (existsSync(path.join(webDir, "package.json"))) {
    const npm = isWin ? "npm.cmd" : "npm";
    // .cmd shims must be invoked through cmd.exe on Windows
    runOrFail(npm, ["install"], { cwd: webDir, shell: isWin });
  }
}

function cmdRun(pkgDir, rawArgs) {
  const serverDir = path.join(pkgDir, "server");
  const env = { ...process.env };
  const args = [...rawArgs];

  while (args.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(args[0])) {
    const eq = args[0].indexOf("=");
    env[args[0].slice(0, eq)] = args[0].slice(eq + 1);
    args.shift();
  }
  if (args.length === 0) {
    console.error("pyenv.mjs run: missing tool name after env vars");
    process.exit(2);
  }

  const [tool, ...toolArgs] = args;
  const exe = venvExe(serverDir, tool);

  const proc = spawn(exe, toolArgs, { stdio: "inherit", cwd: serverDir, env, shell: false });
  proc.on("error", (err) => {
    console.error(`pyenv.mjs run: spawn failed (${exe}): ${err.message}`);
    process.exit(1);
  });
  proc.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

const [mode, ...rest] = process.argv.slice(2);

if (mode === "setup") {
  const pkgDir = rest[0];
  if (!pkgDir) { console.error("setup: missing <pkg-dir>"); process.exit(2); }
  cmdSetup(pkgDir, rest.includes("--with-models"));
} else if (mode === "run") {
  const pkgDir = rest[0];
  if (!pkgDir) { console.error("run: missing <pkg-dir>"); process.exit(2); }
  const dashIdx = rest.indexOf("--");
  const cmdArgs = dashIdx >= 0 ? rest.slice(dashIdx + 1) : rest.slice(1);
  cmdRun(pkgDir, cmdArgs);
} else {
  console.error("Usage: pyenv.mjs setup <pkg-dir> [--with-models]");
  console.error("       pyenv.mjs run <pkg-dir> -- [KEY=VAL ...] <tool> [args...]");
  process.exit(2);
}
