import { describe, it, expect } from "vitest";

import {
  jidType,
  extractText,
  formatForWhatsapp,
} from "../../storeprojects/brAIn-bridges/nodes/whatsapp/src/handler";

describe("jidType", () => {
  it("recognises private chats (@s.whatsapp.net)", () => {
    expect(jidType("49123456789@s.whatsapp.net")).toBe("private");
  });
  it("recognises groups (@g.us)", () => {
    expect(jidType("49123-1632154862@g.us")).toBe("group");
  });
  it("recognises broadcast lists", () => {
    expect(jidType("123@broadcast")).toBe("broadcast");
  });
  it("falls back to unknown for unexpected suffixes", () => {
    expect(jidType("weird")).toBe("unknown");
  });
});

describe("extractText", () => {
  it("returns null for an empty message", () => {
    expect(extractText(null)).toBeNull();
    expect(extractText(undefined as never)).toBeNull();
    expect(extractText({})).toBeNull();
  });

  it("reads conversation (plain text)", () => {
    expect(extractText({ conversation: "hello" })).toBe("hello");
  });

  it("reads extendedTextMessage.text (replies, mentions, link previews)", () => {
    expect(extractText({ extendedTextMessage: { text: "with quote" } })).toBe("with quote");
  });

  it("falls back to imageMessage.caption when caption is the only text", () => {
    expect(extractText({ imageMessage: { caption: "look at this" } })).toBe("look at this");
  });

  it("falls back to videoMessage.caption", () => {
    expect(extractText({ videoMessage: { caption: "this video" } })).toBe("this video");
  });
});

describe("formatForWhatsapp", () => {
  it("returns brain replies verbatim", () => {
    expect(formatForWhatsapp("Hello", {}, "chat.response")).toBe("Hello");
    expect(formatForWhatsapp("Hi", { platform: "web" }, "chat.response.consciousness")).toBe("Hi");
  });

  it("tags chat.input with the source platform + sender", () => {
    expect(formatForWhatsapp("yo", { platform: "telegram", sender: "Alice" }, "chat.input"))
      .toBe("[telegram · Alice] yo");
  });

  it("falls back to sender alone when no platform is set", () => {
    expect(formatForWhatsapp("hi", { sender: "Bob" }, "chat.input")).toBe("[Bob] hi");
  });

  it("returns the bare content when there's nothing to prefix", () => {
    expect(formatForWhatsapp("standalone", {}, "chat.input")).toBe("standalone");
  });
});
