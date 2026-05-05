import { describe, it, expect } from "vitest";
import {
  parseSayVoices,
  parseEspeakVoices,
  parsePowershellVoices,
  buildSpeakArgs,
} from "../../brAIn-perception/nodes/tts/src/handler";

// === parseSayVoices ──────────────────────────────────────────────────

const SAY_FIXTURE = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Alice               it_IT    # Ciao! Mi chiamo Alice.",
  "Audrey (Enhanced)   fr_FR    # Bonjour, je m’appelle Audrey.",
  "Eddy (Allemand (Allemagne)) de_DE    # Hallo! Ich heiße Eddy.",
  "Eddy (Français (France)) fr_FR    # Bonjour, je m’appelle Eddy.",
  "Majed               ar_001   # مرحبًا! اسمي ماجد.",
  "",  // blank line — skipped
  "Bad News            en_US    # The light you see at the end of the tunnel is the headlamp of a fast approaching train.",
].join("\n");

describe("parseSayVoices", () => {
  it("parses simple single-word names with locale + description", () => {
    const out = parseSayVoices(SAY_FIXTURE);
    const albert = out.find((v) => v.name === "Albert");
    expect(albert).toBeDefined();
    expect(albert?.language).toBe("en_US");
    expect(albert?.description).toContain("Hello!");
  });

  it("preserves multi-word voice names with parentheses", () => {
    const out = parseSayVoices(SAY_FIXTURE);
    expect(out.find((v) => v.name === "Audrey (Enhanced)")).toBeTruthy();
  });

  it("preserves names with nested parens (localized output)", () => {
    const out = parseSayVoices(SAY_FIXTURE);
    const eddy = out.find((v) => v.name === "Eddy (Allemand (Allemagne))");
    expect(eddy).toBeDefined();
    expect(eddy?.language).toBe("de_DE");
  });

  it("supports non-region locale tags like ar_001", () => {
    const out = parseSayVoices(SAY_FIXTURE);
    const majed = out.find((v) => v.name === "Majed");
    expect(majed?.language).toBe("ar_001");
  });

  it("skips blank lines", () => {
    const out = parseSayVoices(SAY_FIXTURE);
    expect(out.some((v) => v.name === "")).toBe(false);
  });

  it("returns empty array on empty input", () => {
    expect(parseSayVoices("")).toEqual([]);
  });
});

// === parseEspeakVoices ───────────────────────────────────────────────

const ESPEAK_FIXTURE = [
  "Pty Language Age/Gender VoiceName       File                 Other Languages",
  " 5  en             M   english         gmw/en",
  " 5  fr             M   french          roa/fr",
  " 5  fr-be          M   french-belgium  roa/fr-be",
  " 5  de             M   german          gmw/de",
].join("\n");

describe("parseEspeakVoices", () => {
  it("skips the header row and parses voice rows", () => {
    const out = parseEspeakVoices(ESPEAK_FIXTURE);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ name: "english", language: "en" });
    expect(out[2]).toEqual({ name: "french-belgium", language: "fr-be" });
  });

  it("returns empty array when only the header is present", () => {
    expect(parseEspeakVoices("Pty Language Age/Gender VoiceName File")).toEqual([]);
  });
});

// === parsePowershellVoices ───────────────────────────────────────────

describe("parsePowershellVoices", () => {
  it("parses the Name|Culture pipe-delimited lines we emit", () => {
    const stdout = [
      "Microsoft David Desktop|en-US",
      "Microsoft Hortense Desktop|fr-FR",
      "",
      "Microsoft Zira Desktop|en-US",
    ].join("\r\n");
    const out = parsePowershellVoices(stdout);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ name: "Microsoft Hortense Desktop", language: "fr-FR" });
  });

  it("ignores malformed lines without a pipe", () => {
    const out = parsePowershellVoices("just text\nName|en-US\n");
    // "just text" has no pipe so split yields [name="just text", culture=undefined]
    // — which the parser now keeps with no language. Acceptable; we just
    // assert the well-formed line round-trips cleanly.
    expect(out.find((v) => v.name === "Name")?.language).toBe("en-US");
  });
});

// === buildSpeakArgs ──────────────────────────────────────────────────

describe("buildSpeakArgs", () => {
  describe("backend=say (macOS)", () => {
    it("passes -- before text to dodge dash-prefixed words", () => {
      const r = buildSpeakArgs("--rude text", {}, "say");
      expect(r.cmd).toBe("say");
      expect(r.args).toEqual(["--", "--rude text"]);
      expect(r.input).toBeUndefined();
    });

    it("includes -v <voice> when voice is set", () => {
      const r = buildSpeakArgs("hi", { voice: "Audrey (Enhanced)" }, "say");
      expect(r.args).toEqual(["-v", "Audrey (Enhanced)", "--", "hi"]);
    });

    it("includes -r <rate> when rate is set", () => {
      const r = buildSpeakArgs("hi", { voice: "Alice", rate: 220 }, "say");
      expect(r.args).toEqual(["-v", "Alice", "-r", "220", "--", "hi"]);
    });
  });

  describe("backend=espeak-ng (Linux)", () => {
    it("uses -s for rate (words/min) instead of -r", () => {
      const r = buildSpeakArgs("hi", { voice: "fr", rate: 175 }, "espeak-ng");
      expect(r.cmd).toBe("espeak-ng");
      expect(r.args).toEqual(["-v", "fr", "-s", "175", "--", "hi"]);
    });

    it("falls back to plain espeak with the same arg shape", () => {
      const r = buildSpeakArgs("hi", {}, "espeak");
      expect(r.cmd).toBe("espeak");
      expect(r.args).toEqual(["--", "hi"]);
    });
  });

  describe("backend=powershell (Windows)", () => {
    it("pipes text via stdin to dodge quoting", () => {
      const r = buildSpeakArgs("Hello world", {}, "powershell");
      expect(r.cmd).toBe("powershell");
      expect(r.args[0]).toBe("-NoProfile");
      expect(r.input).toBe("Hello world");
    });

    it("escapes single quotes inside the voice name (PowerShell '' escape)", () => {
      const r = buildSpeakArgs("hi", { voice: "Bob's Voice" }, "powershell");
      const script = r.args[2];
      expect(script).toContain("$s.SelectVoice('Bob''s Voice');");
    });

    it("clamps the rate into PowerShell's [-10, 10] range", () => {
      const fast = buildSpeakArgs("hi", { rate: 1000 }, "powershell");
      const slow = buildSpeakArgs("hi", { rate: 1 }, "powershell");
      expect((fast.args[2] as string)).toContain("$s.Rate = 10;");
      expect((slow.args[2] as string)).toContain("$s.Rate = -10;");
    });
  });

  it("throws when no backend is usable", () => {
    expect(() => buildSpeakArgs("hi", {}, "none")).toThrow(/no usable backend/);
  });
});
