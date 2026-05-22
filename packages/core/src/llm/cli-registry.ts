import { exec, spawn } from "child_process";
import { logger } from "../logger";

export interface CLIStatus {
  name: string;
  command: string;
  available: boolean;
  version?: string;
  error?: string;
  /** Shell snippets the dashboard surfaces in the per-CLI card. Both
   *  steps are user-run in their own terminal because auth opens a
   *  browser — we can't drive it from the API. */
  installCommand: string;
  loginCommand: string;
  homepage: string;
}

interface CLIEntry {
  name: string;
  command: string;
  versionFlag: string;
  execTemplate: string;
  installCommand: string;
  loginCommand: string;
  homepage: string;
}

export interface CLIRunResult {
  /** The assistant's answer, extracted from the CLI's output envelope. */
  text: string;
  /** Untouched stdout — useful for debugging an unexpected envelope. */
  raw: string;
  exitCode: number;
  /** Set when the CLI errored (non-zero exit, timeout, abort). */
  error?: string;
}

export interface CLIRunOptions {
  /** Working directory the CLI runs in. brAIn scopes this to the calling
   *  node's dataDir so an agent's file ops stay in its own sandbox. */
  cwd?: string;
  /** Hard wall-clock cap. Agentic CLIs can run long; default 120s. */
  timeoutMs?: number;
  /** Abort signal — wired from `ctx.signal` so a killed wake stops the CLI. */
  signal?: AbortSignal;
  /** Optional line-by-line stream of stdout/stderr as the CLI works —
   *  the developer node uses this to push live progress to its UI. */
  onLine?: (line: string) => void;
}

const BUILTIN_CLIS: CLIEntry[] = [
  {
    name: "claude",
    command: "claude",
    versionFlag: "--version",
    execTemplate: "claude -p {prompt} --output-format json --max-turns 1",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    loginCommand: "claude /login",
    homepage: "https://docs.claude.com/en/docs/claude-code/quickstart",
  },
  {
    name: "codex",
    command: "codex",
    versionFlag: "--version",
    execTemplate: "codex exec {prompt}",
    installCommand: "npm install -g @openai/codex",
    loginCommand: "codex login",
    homepage: "https://github.com/openai/codex",
  },
  {
    name: "gemini",
    command: "gemini",
    versionFlag: "--version",
    execTemplate: "gemini -p {prompt} --output-format json",
    installCommand: "npm install -g @google/gemini-cli",
    loginCommand: "gemini auth login",
    homepage: "https://github.com/google-gemini/gemini-cli",
  },
];

let instance: CLIRegistry | null = null;

function runCommand(
  cmd: string,
  timeoutMs: number,
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(
      cmd,
      // 8MB buffer: agentic CLIs can be chatty on stdout (JSON envelope +
      // reasoning). Default 1MB truncates and surfaces as a spurious error.
      { timeout: timeoutMs, cwd: opts.cwd, signal: opts.signal, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ stdout, stderr, exitCode: err ? (err.code ?? 1) : 0 });
      },
    );
  });
}

/** Pull the assistant's answer out of a CLI's stdout. Each agentic CLI
 *  has its own envelope; we parse the known shape and fall back to common
 *  field names, then to the raw text — so an unrecognised format degrades
 *  to "show what we got" rather than throwing. */
function parseCliOutput(name: string, stdout: string): string {
  const raw = stdout.trim();
  if (!raw) return "";
  // codex `exec` streams plain text — no JSON envelope.
  if (name === "codex") return raw;
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    // claude-code: { type, subtype, result, ... }; gemini: { response, ... }.
    for (const key of ["result", "response", "text", "content", "output"]) {
      const v = json[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return raw;
  } catch {
    return raw; // not JSON (or partial) — hand back what the CLI printed.
  }
}

export class CLIRegistry {
  private readonly clis = new Map<string, CLIEntry>();
  private readonly statuses = new Map<string, CLIStatus>();
  private initialized = false;

  static getInstance(): CLIRegistry {
    if (!instance) {
      instance = new CLIRegistry();
    }
    return instance;
  }

  constructor() {
    for (const cli of BUILTIN_CLIS) {
      this.clis.set(cli.name, cli);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info("Checking CLI agent availability...");

    const checks = Array.from(this.clis.entries()).map(
      async ([key, cli]) => {
        try {
          const result = await runCommand(`which ${cli.command}`, 5000);

          if (result.exitCode !== 0) {
            this.statuses.set(key, {
              name: cli.name,
              command: cli.command,
              available: false,
              error: "Command not found in PATH",
              installCommand: cli.installCommand,
              loginCommand: cli.loginCommand,
              homepage: cli.homepage,
            });
            logger.warn({ cli: key }, "CLI not found");
            return;
          }

          // Try to get version
          const versionResult = await runCommand(`${cli.command} ${cli.versionFlag}`, 10000);
          const version = versionResult.stdout.trim().split("\n")[0];

          this.statuses.set(key, {
            name: cli.name,
            command: cli.command,
            available: true,
            version: version || undefined,
            installCommand: cli.installCommand,
            loginCommand: cli.loginCommand,
            homepage: cli.homepage,
          });
          logger.info({ cli: key, version }, "CLI available");
        } catch (err) {
          this.statuses.set(key, {
            name: cli.name,
            command: cli.command,
            available: false,
            error: err instanceof Error ? err.message : String(err),
            installCommand: cli.installCommand,
            loginCommand: cli.loginCommand,
            homepage: cli.homepage,
          });
          logger.warn({ cli: key, error: String(err) }, "CLI check failed");
        }
      },
    );

    await Promise.allSettled(checks);
    this.initialized = true;

    const available = Array.from(this.statuses.values()).filter((s) => s.available);
    logger.info(
      { available: available.map((s) => s.name), total: this.clis.size },
      "CLI registry initialized",
    );
  }

  getExecTemplate(name: string): string {
    const cli = this.clis.get(name);
    if (!cli) {
      throw new Error(`Unknown CLI: ${name}. Available: ${Array.from(this.clis.keys()).join(", ")}`);
    }
    return cli.execTemplate;
  }

  buildCommand(name: string, prompt: string): string {
    const template = this.getExecTemplate(name);
    // Escape single quotes in prompt for shell safety
    const escaped = prompt.replace(/'/g, "'\\''");
    return template.replace("{prompt}", `'${escaped}'`);
  }

  /** CLI args for a stdin-piped invocation. Mirrors the developer node's
   *  proven approach: the prompt goes in on stdin (no shell escaping), and
   *  claude gets the agentic flags (`--max-turns`, skip interactive perms)
   *  so it actually runs its tool loop instead of stalling on a prompt.
   *  codex/gemini and unknowns stick to the portable `-p -` subset. */
  buildCliArgs(name: string): string[] {
    const stdinPrompt = ["-p", "-"];
    if (name === "claude") {
      return [...stdinPrompt, "--max-turns", "40", "--dangerously-skip-permissions"];
    }
    return stdinPrompt;
  }

  /** The CLI a node should use, in priority order: an explicit per-message
   *  `cli` → the node's `config_overrides.cli` → the first available CLI.
   *  Mirrors the developer node's `pickCli` so selection is consistent. */
  pickCli(configCli?: string, messageCli?: string): string | undefined {
    return messageCli ?? configCli ?? this.getAvailableCLIs()[0];
  }

  /** Run a detected CLI agent with a prompt and return its answer.
   *
   *  The CLI runs its OWN agentic tool loop (claude-code, codex, gemini
   *  are themselves agents); brAIn just hands it a prompt over stdin, a
   *  scoped cwd, and a deadline, then parses the answer out of its output
   *  envelope. Shares the spawn+stdin path the developer node pioneered
   *  (see buildCliArgs) so both go through one execution route. */
  async run(name: string, prompt: string, opts: CLIRunOptions = {}): Promise<CLIRunResult> {
    await this.initialize();
    const cli = this.clis.get(name);
    if (!cli) {
      throw new Error(`Unknown CLI: ${name}. Available: ${Array.from(this.clis.keys()).join(", ")}`);
    }
    if (!this.isAvailable(name)) {
      const status = this.statuses.get(name);
      throw new Error(
        `CLI '${name}' is not available: ${status?.error ?? "not installed"}. ` +
        `Install with: ${status?.installCommand ?? "see dashboard"}`,
      );
    }
    const result = await this.spawnCli(cli.command, this.buildCliArgs(name), prompt, opts);
    const text = parseCliOutput(name, result.stdout);
    if (result.exitCode !== 0) {
      return {
        text,
        raw: result.stdout,
        exitCode: result.exitCode,
        error: result.stderr.trim() || `CLI '${name}' exited with code ${result.exitCode}`,
      };
    }
    return { text, raw: result.stdout, exitCode: 0 };
  }

  /** Spawn a CLI with the prompt piped to stdin, capturing stdout/stderr
   *  and optionally streaming lines as they arrive. Never rejects — a
   *  spawn error resolves with a non-zero exitCode so callers branch on
   *  the result rather than try/catch. */
  private spawnCli(
    command: string,
    args: string[],
    prompt: string,
    opts: CLIRunOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        signal: opts.signal,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      let stdout = "";
      let stderr = "";
      proc.stdin.on("error", () => { /* CLI may close stdin early — ignore EPIPE */ });
      proc.stdin.write(prompt);
      proc.stdin.end();
      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (opts.onLine) for (const line of text.split("\n").filter(Boolean)) opts.onLine(line);
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        if (opts.onLine) for (const line of text.split("\n").filter(Boolean)) opts.onLine(`[stderr] ${line}`);
      });
      proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
      proc.on("error", (err) => resolve({ stdout, stderr: stderr + err.message, exitCode: 1 }));
    });
  }

  getStatuses(): CLIStatus[] {
    return Array.from(this.statuses.values());
  }

  getAvailableCLIs(): string[] {
    return Array.from(this.statuses.entries())
      .filter(([, s]) => s.available)
      .map(([key]) => key);
  }

  isAvailable(name: string): boolean {
    return this.statuses.get(name)?.available ?? false;
  }

  /** Force a re-check — useful after the user installs / removes a CLI
   *  and wants to see the change without restarting the API. */
  async refresh(): Promise<void> {
    this.initialized = false;
    this.statuses.clear();
    await this.initialize();
  }
}
