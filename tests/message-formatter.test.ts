import { describe, it, expect } from "vitest";
import { resolveRoute } from "../nodes/brain/src/message-formatter";

describe("resolveRoute", () => {
  // Topic aliasing
  it("aliases memory.store to mem.store", () => {
    const route = resolveRoute("memory.store");
    expect(route.topic).toBe("mem.store");
  });

  it("aliases memory.search to mem.ask", () => {
    const route = resolveRoute("memory.search");
    expect(route.topic).toBe("mem.ask");
  });

  it("aliases memory.recall to mem.ask", () => {
    const route = resolveRoute("memory.recall");
    expect(route.topic).toBe("mem.ask");
  });

  it("passes through unknown topics unchanged", () => {
    const route = resolveRoute("custom.topic");
    expect(route.topic).toBe("custom.topic");
  });

  it("passes through correct topics unchanged", () => {
    const route = resolveRoute("cmd.exec");
    expect(route.topic).toBe("cmd.exec");
  });

  // Format function
  it("format is always a function", () => {
    const route = resolveRoute("anything");
    expect(typeof route.format).toBe("function");
  });

  it("format passes content through for unknown topics", () => {
    const route = resolveRoute("custom.topic");
    expect(route.format("hello world")).toBe("hello world");
  });

  // Response topic discovery (requires BrainService.current — null in unit tests)
  it("returns empty responseTopic when no BrainService is running", () => {
    const route = resolveRoute("cmd.exec");
    expect(route.responseTopic).toBe("");
    expect(route.timeout).toBe(0);
  });
});
