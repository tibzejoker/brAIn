/**
 * CLI agent delegation — `ctx.llm.agent()` + the shared CLIRegistry
 * execution path.
 *
 * The agentic CLIs (claude-code, codex, gemini) run their OWN tool loop;
 * brAIn detects them (CLIRegistry, reused by the developer node), hands
 * one a prompt over stdin in a sandboxed cwd, and parses the answer back.
 * These tests pin the pure selection/arg helpers and the facade routing —
 * the fake CLI runner stands in for a real binary on PATH.
 */
import { describe, it, expect } from "vitest";
import { BusService, CLIRegistry, LLMFacade } from "@brain/core";
import type { CLIRunResult } from "@brain/core";

describe("CLIRegistry helpers", () => {
  const reg = CLIRegistry.getInstance();

  it("pipes the prompt via stdin and gives claude its agentic flags", () => {
    expect(reg.buildCliArgs("claude")).toEqual([
      "-p", "-", "--max-turns", "40", "--dangerously-skip-permissions",
    ]);
    // codex/gemini/unknown stick to the portable subset.
    expect(reg.buildCliArgs("codex")).toEqual(["-p", "-"]);
    expect(reg.buildCliArgs("gemini")).toEqual(["-p", "-"]);
  });

  it("picks a CLI in priority order: message → config → first available", () => {
    expect(reg.pickCli("claude", "gemini")).toBe("gemini"); // message wins
    expect(reg.pickCli("claude", undefined)).toBe("claude"); // then config
  });

  it("run() rejects an unknown CLI", async () => {
    await expect(reg.run("not-a-cli", "hi")).rejects.toThrow(/Unknown CLI/);
  });
});

/** Minimal fake runner — stands in for a real claude/codex/gemini binary. */
function fakeCli(result: CLIRunResult): { calls: Array<{ name: string; prompt: string }>; run: (n: string, p: string) => Promise<CLIRunResult> } {
  const calls: Array<{ name: string; prompt: string }> = [];
  return {
    calls,
    run: (name, prompt) => { calls.push({ name, prompt }); return Promise.resolve(result); },
  };
}

function facade(opts: { bus: BusService; cli: { run: (n: string, p: string) => Promise<CLIRunResult> }; nodeCli?: string }): LLMFacade {
  return new LLMFacade({
    // agent() only touches bus / cli / nodeCli / signal — registry+config
    // are unused on this path, so minimal stubs are fine.
    registry: {} as never,
    config: {} as never,
    bus: opts.bus,
    nodeId: "n1", nodeName: "tester", nodeType: "demo",
    nodeCli: opts.nodeCli,
    cli: opts.cli,
    signal: new AbortController().signal,
  });
}

describe("ctx.llm.agent()", () => {
  it("delegates to the selected CLI and returns its parsed answer", async () => {
    const cli = fakeCli({ text: "done ✅", raw: "{\"result\":\"done ✅\"}", exitCode: 0 });
    const llm = facade({ bus: new BusService(), cli, nodeCli: "claude" });

    const res = await llm.agent({ prompt: "build me a thing" });

    expect(res.text).toBe("done ✅");
    expect(res.cli).toBe("claude");
    expect(cli.calls).toHaveLength(1);
    expect(cli.calls[0].name).toBe("claude");
  });

  it("opts.cli overrides the node's configured CLI", async () => {
    const cli = fakeCli({ text: "ok", raw: "ok", exitCode: 0 });
    const llm = facade({ bus: new BusService(), cli, nodeCli: "claude" });

    await llm.agent({ prompt: "x", cli: "gemini" });

    expect(cli.calls[0].name).toBe("gemini");
  });

  it("folds system + prompt into one CLI prompt string", async () => {
    const cli = fakeCli({ text: "", raw: "", exitCode: 0 });
    const llm = facade({ bus: new BusService(), cli, nodeCli: "claude" });

    await llm.agent({ prompt: "the task", system: "you are X" });

    expect(cli.calls[0].prompt).toContain("you are X");
    expect(cli.calls[0].prompt).toContain("the task");
  });

  it("throws when no CLI is selected", async () => {
    const llm = facade({ bus: new BusService(), cli: fakeCli({ text: "", raw: "", exitCode: 0 }) });
    await expect(llm.agent({ prompt: "x" })).rejects.toThrow(/no CLI selected/);
  });

  it("surfaces a CLI error (non-zero exit) as a throw", async () => {
    const cli = fakeCli({ text: "", raw: "", exitCode: 1, error: "boom" });
    const llm = facade({ bus: new BusService(), cli, nodeCli: "claude" });
    await expect(llm.agent({ prompt: "x" })).rejects.toThrow(/boom/);
  });

  it("emits a `cli` usage event on the bus", async () => {
    const bus = new BusService();
    const published: Array<{ topic: string; metadata?: { call_kind?: string } }> = [];
    bus.on("message:published", (m: { topic: string; metadata?: { call_kind?: string } }) => published.push(m));
    const cli = fakeCli({ text: "hi", raw: "hi", exitCode: 0 });
    const llm = facade({ bus, cli, nodeCli: "claude" });

    await llm.agent({ prompt: "x" });

    const usage = published.find((m) => m.topic === "llm.usage");
    expect(usage?.metadata?.call_kind).toBe("cli");
  });
});
