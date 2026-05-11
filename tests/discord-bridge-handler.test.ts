import { describe, it, expect } from "vitest";

import {
  formatForDiscord,
  stripMentions,
} from "../../storeprojects/brAIn-bridges/nodes/discord/src/handler";

describe("formatForDiscord", () => {
  it("returns brain replies verbatim", () => {
    expect(formatForDiscord("Hello", {}, "chat.response")).toBe("Hello");
    expect(formatForDiscord("Hi", { platform: "web" }, "chat.response.consciousness")).toBe("Hi");
  });

  it("tags chat.input with the source platform + sender", () => {
    expect(formatForDiscord("yo", { platform: "telegram", sender: "Alice" }, "chat.input"))
      .toBe("[telegram · Alice] yo");
  });

  it("falls back to sender alone when no platform is set", () => {
    expect(formatForDiscord("hi", { sender: "Bob" }, "chat.input")).toBe("[Bob] hi");
  });

  it("returns the bare content when there's nothing to prefix", () => {
    expect(formatForDiscord("standalone", {}, "chat.input")).toBe("standalone");
  });
});

describe("stripMentions", () => {
  it("removes the bot's own mention token from anywhere in the text", () => {
    expect(stripMentions("<@123> what's up", "123")).toBe("what's up");
    expect(stripMentions("hey <@!123> hey", "123")).toBe("hey hey");
  });

  it("drops other user mentions too (no nickname resolution in v1)", () => {
    expect(stripMentions("<@999> sup <@123>", "123")).toBe("sup");
  });

  it("collapses double-spaces left by the stripped token", () => {
    expect(stripMentions("a  <@123>  b", "123")).toBe("a b");
  });

  it("returns the trimmed bare text when no mentions are present", () => {
    expect(stripMentions("  plain text  ", "123")).toBe("plain text");
  });

  it("works without a bot id (still strips generic mentions)", () => {
    expect(stripMentions("<@42> hi", undefined)).toBe("hi");
  });
});
