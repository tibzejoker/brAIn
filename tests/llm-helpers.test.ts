import { describe, it, expect } from "vitest";
import {
  stripReasoningTags,
  extractReasoningText,
  parseTolerantJson,
  repairTruncatedJson,
} from "../packages/core/src/llm";

describe("stripReasoningTags", () => {
  it("removes <think>…</think> blocks", () => {
    const s = "Hello <think>internal reasoning</think> world";
    expect(stripReasoningTags(s)).toBe("Hello  world");
  });

  it("removes <thinking>…</thinking> blocks", () => {
    expect(stripReasoningTags("a <thinking>x</thinking> b")).toBe("a  b");
  });

  it("drops unclosed trailing <think> tag (model ran out of tokens)", () => {
    const s = "Final answer here\n<think>chain of thought never closed";
    expect(stripReasoningTags(s)).toBe("Final answer here");
  });

  it("trims surrounding whitespace from the result", () => {
    expect(stripReasoningTags("  \n  hi  \n  ")).toBe("hi");
  });

  it("leaves untagged text alone", () => {
    expect(stripReasoningTags("just plain text")).toBe("just plain text");
  });
});

describe("extractReasoningText", () => {
  it("reads .text when present", () => {
    expect(extractReasoningText({ text: "answer" })).toBe("answer");
  });

  it("falls back to .steps[0].text", () => {
    expect(extractReasoningText({ text: "", steps: [{ text: "step-answer" }] })).toBe("step-answer");
  });

  it("falls back to .reasoning when text + steps are empty", () => {
    expect(extractReasoningText({ text: "", steps: [], reasoning: "reasoned-answer" })).toBe("reasoned-answer");
  });

  it("strips <think> blocks from the result by default", () => {
    expect(extractReasoningText({ text: "<think>x</think>real answer" })).toBe("real answer");
  });

  it("preserves <think> when stripReasoning=false", () => {
    expect(extractReasoningText({ text: "<think>x</think>y" }, { stripReasoning: false })).toBe("<think>x</think>y");
  });

  it("returns null when nothing usable is present", () => {
    expect(extractReasoningText({})).toBeNull();
    expect(extractReasoningText({ text: "" })).toBeNull();
  });
});

describe("parseTolerantJson", () => {
  it("parses plain JSON", () => {
    expect(parseTolerantJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("normalises leading + on numbers (`+15` → `15`)", () => {
    expect(parseTolerantJson('{"happiness":+15}')).toEqual({ happiness: 15 });
  });

  it("strips trailing commas", () => {
    expect(parseTolerantJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it("repairs single-quoted keys", () => {
    expect(parseTolerantJson("{'a':1}")).toEqual({ a: 1 });
  });
});

describe("repairTruncatedJson", () => {
  it("returns {} for hopeless garbage", () => {
    expect(repairTruncatedJson("not json at all")).toEqual({});
  });

  it("recovers from trailing partial key (`{\"a\":1,\"b`)", () => {
    expect(repairTruncatedJson('{"a":1,"b')).toEqual({ a: 1 });
  });

  it("recovers from missing closing brace", () => {
    expect(repairTruncatedJson('{"a":1')).toEqual({ a: 1 });
  });

  it("recovers from mid-pair cutoff", () => {
    expect(repairTruncatedJson('{"happiness":-10,"')).toEqual({ happiness: -10 });
  });

  it("passes through valid JSON unchanged", () => {
    expect(repairTruncatedJson('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
  });
});
