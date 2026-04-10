import { describe, it, expect, beforeAll } from "vitest";
import { LLMRegistry, CLIRegistry, generateText } from "@brain/core";

describe("LLMRegistry", () => {
  let registry: LLMRegistry;

  beforeAll(async () => {
    // Reset singleton so it picks up env vars from vitest
    LLMRegistry.resetInstance();
    registry = LLMRegistry.getInstance();
    await registry.initialize();
  }, 60000);

  it("detects Ollama as available", () => {
    expect(registry.isAvailable("ollama")).toBe(true);
  });

  it("returns model for ollama/gemma4:e2b", () => {
    const model = registry.getModel("ollama/gemma4:e2b");
    expect(model).toBeDefined();
  });

  it("generates text with Ollama gemma4:e2b", async () => {
    const model = registry.getModel("ollama/gemma4:e2b");

    const result = await generateText({
      model,
      prompt: "Reply with exactly the word 'hello' and nothing else.",
      maxOutputTokens: 20,
    });

    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain("hello");
  }, 30000);

  it("generates text with system prompt", async () => {
    const model = registry.getModel("ollama/gemma4:e2b");

    const result = await generateText({
      model,
      system: "You are a calculator. Only respond with numbers.",
      messages: [{ role: "user", content: "What is 2 + 2?" }],
      maxOutputTokens: 20,
    });

    expect(result.text).toBeDefined();
    expect(result.text).toContain("4");
  }, 30000);

  it("reports provider statuses", () => {
    const statuses = registry.getStatuses();
    expect(statuses.length).toBeGreaterThan(0);

    const ollama = statuses.find((s) => s.name === "ollama");
    expect(ollama).toBeDefined();
    expect(ollama?.available).toBe(true);
  });

  it("throws on unknown provider", () => {
    expect(() => registry.getModel("nonexistent/model")).toThrow("Unknown LLM provider");
  });
});

describe("CLIRegistry", () => {
  let registry: CLIRegistry;

  beforeAll(async () => {
    registry = CLIRegistry.getInstance();
    await registry.initialize();
  }, 30000);

  it("detects available CLI agents", () => {
    const statuses = registry.getStatuses();
    expect(statuses.length).toBeGreaterThan(0);

    // At least one should be checked (even if not available)
    for (const status of statuses) {
      expect(status.name).toBeDefined();
      expect(typeof status.available).toBe("boolean");
    }
  });

  it("builds shell commands with escaped prompts", () => {
    const cmd = registry.buildCommand("claude", "What's the time?");
    expect(cmd).toContain("claude");
    expect(cmd).toContain("What");
  });

  it("lists available CLIs", () => {
    const available = registry.getAvailableCLIs();
    expect(Array.isArray(available)).toBe(true);
  });
});
