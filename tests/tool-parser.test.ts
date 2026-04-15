import { describe, it, expect } from "vitest";
import { parseToolCall, parseSleepRequest } from "../nodes/brain/src/tool-parser";

describe("parseToolCall", () => {
  it("parses clean JSON", () => {
    const result = parseToolCall('{"tool": "publish_message", "args": {"topic": "cmd.exec", "content": "ls"}}');
    expect(result).toEqual({ tool: "publish_message", args: { topic: "cmd.exec", content: "ls" } });
  });

  it("parses JSON with trailing comma", () => {
    const result = parseToolCall('{"tool": "inspect_network", "args": {},}');
    expect(result).not.toBeNull();
    expect(result?.tool).toBe("inspect_network");
  });

  it("parses JSON with single quotes", () => {
    const result = parseToolCall("{'tool': 'sleep', 'args': {'duration': '5m'}}");
    expect(result).toEqual({ tool: "sleep", args: { duration: "5m" } });
  });

  it("parses JSON with unquoted keys", () => {
    const result = parseToolCall('{tool: "think", args: {thought: "hmm"}}');
    expect(result).toEqual({ tool: "think", args: { thought: "hmm" } });
  });

  it("extracts JSON from markdown fence", () => {
    const text = 'Here is my action:\n```json\n{"tool": "kill_node", "args": {"node_id": "abc"}}\n```';
    const result = parseToolCall(text);
    expect(result?.tool).toBe("kill_node");
    expect(result?.args.node_id).toBe("abc");
  });

  it("extracts JSON embedded in prose", () => {
    const text = 'I will now execute this: {"tool": "publish_message", "args": {"topic": "mem.store", "content": "hello"}} and wait.';
    const result = parseToolCall(text);
    expect(result?.tool).toBe("publish_message");
  });

  it("handles tool_name field variant", () => {
    const result = parseToolCall('{"tool_name": "inspect_network", "arguments": {}}');
    expect(result?.tool).toBe("inspect_network");
  });

  it("handles name + parameters field variants", () => {
    const result = parseToolCall('{"name": "think", "parameters": {"thought": "ok"}}');
    expect(result?.tool).toBe("think");
    expect(result?.args.thought).toBe("ok");
  });

  it("handles apostrophes in content values", () => {
    const text = '{"tool": "publish_message", "args": {"topic": "mem.ask", "content": "Quelles infos sur l\'utilisateur?"}}';
    const result = parseToolCall(text);
    expect(result?.tool).toBe("publish_message");
    expect(result?.args.content).toContain("utilisateur");
  });

  it("returns null for plain text", () => {
    expect(parseToolCall("Hello, I'm thinking about what to do.")).toBeNull();
  });

  it("returns null for JSON without tool field", () => {
    expect(parseToolCall('{"action": "do_something"}')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseToolCall("")).toBeNull();
  });
});

describe("parseSleepRequest", () => {
  it("parses sleep tool call", () => {
    expect(parseSleepRequest('{"tool": "sleep", "args": {"duration": "5m"}}')).toBe("5m");
  });

  it("parses sleep with single quotes", () => {
    expect(parseSleepRequest("{'tool': 'sleep', 'args': {'duration': '30s'}}")).toBe("30s");
  });

  it("parses natural language sleep", () => {
    expect(parseSleepRequest("I'll sleep for 10 minutes now.")).toBe("10m");
  });

  it("parses natural language with seconds", () => {
    expect(parseSleepRequest("Going to sleep for 30 seconds")).toBe("30s");
  });

  it("returns null for non-sleep tool call", () => {
    expect(parseSleepRequest('{"tool": "think", "args": {"thought": "sleep is nice"}}')).toBeNull();
  });

  it("returns null for text mentioning sleep without duration", () => {
    expect(parseSleepRequest("I should probably sleep")).toBeNull();
  });
});
