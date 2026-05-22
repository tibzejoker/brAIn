/**
 * Shared shell-exec helper.
 *
 * Several nodes (terminal, llm-cli, …) each reimplemented the same
 * `exec`-with-timeout wrapper. It lives here once so they call the
 * framework instead of duplicating it. Resolves (never rejects) with the
 * captured output + exit code so callers branch on the result.
 */
import { exec } from "child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  /** Wall-clock cap in ms. Default 30s. */
  timeoutMs?: number;
  /** Abort signal — wires SIGTERM-on-abort so a preempted/killed wake
   *  stops a long-running child immediately. */
  signal?: AbortSignal;
  /** stdout/stderr buffer cap. Default 5MB — command output can be large. */
  maxBuffer?: number;
}

export function execCommand(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        signal: opts.signal,
        maxBuffer: opts.maxBuffer ?? 5 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({ stdout, stderr, exitCode: err ? (err.code ?? 1) : 0 });
      },
    );
  });
}
