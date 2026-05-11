import { describe, it, expect } from "vitest";

import { formatForTelegram } from "../../storeprojects/brAIn-bridges/nodes/telegram/src/handler";

describe("formatForTelegram", () => {
  it("returns brain replies verbatim — no tag, no decoration", () => {
    expect(formatForTelegram("Hello there", {}, "chat.response")).toBe("Hello there");
    expect(formatForTelegram("Hi", { platform: "web" }, "chat.response.consciousness")).toBe("Hi");
  });

  it("tags chat.input with the source platform + sender so TG users see who said it", () => {
    expect(
      formatForTelegram("yo", { platform: "web", sender: "Thibaut" }, "chat.input"),
    ).toBe("[web · Thibaut] yo");
  });

  it("falls back to the sender alone when no platform tag is set", () => {
    expect(formatForTelegram("hi", { sender: "Alice" }, "chat.input")).toBe("[Alice] hi");
  });

  it("returns the bare content when there's nothing useful to prefix", () => {
    expect(formatForTelegram("standalone", {}, "chat.input")).toBe("standalone");
  });
});
