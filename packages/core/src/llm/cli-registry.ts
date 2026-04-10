import { exec } from "child_process";
import { logger } from "../logger";

export interface CLIStatus {
  name: string;
  command: string;
  available: boolean;
  version?: string;
  error?: string;
}

interface CLIEntry {
  name: string;
  command: string;
  versionFlag: string;
  execTemplate: string;
}

const BUILTIN_CLIS: CLIEntry[] = [
  {
    name: "claude",
    command: "claude",
    versionFlag: "--version",
    execTemplate: "claude -p {prompt} --output-format json --max-turns 1",
  },
  {
    name: "codex",
    command: "codex",
    versionFlag: "--version",
    execTemplate: "codex exec {prompt}",
  },
  {
    name: "gemini",
    command: "gemini",
    versionFlag: "--version",
    execTemplate: "gemini -p {prompt} --output-format json",
  },
];

let instance: CLIRegistry | null = null;

function runCommand(cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: err ? (err.code ?? 1) : 0,
      });
    });
  });
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
          });
          logger.info({ cli: key, version }, "CLI available");
        } catch (err) {
          this.statuses.set(key, {
            name: cli.name,
            command: cli.command,
            available: false,
            error: err instanceof Error ? err.message : String(err),
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
}
