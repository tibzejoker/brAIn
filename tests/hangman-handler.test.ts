import { describe, it, expect } from "vitest";

import {
  maskWord,
  isSolved,
  renderMasked,
  renderStage,
  classifyGuess,
  parseControl,
} from "../../storeprojects/brAIn-games/nodes/hangman/src/handler";

describe("maskWord", () => {
  it("hides letters that haven't been tried", () => {
    expect(maskWord("brain", [])).toEqual([null, null, null, null, null]);
  });

  it("reveals tried letters case-insensitively", () => {
    expect(maskWord("brain", ["b", "I"])).toEqual(["B", null, null, "I", null]);
  });

  it("always reveals non-letter characters (spaces, hyphens)", () => {
    expect(maskWord("hot dog", [])).toEqual([null, null, null, " ", null, null, null]);
  });
});

describe("isSolved", () => {
  it("returns false while letters remain hidden", () => {
    expect(isSolved("brain", ["b", "r"])).toBe(false);
  });

  it("returns true once every letter has been guessed", () => {
    expect(isSolved("brain", ["b", "r", "a", "i", "n"])).toBe(true);
  });

  it("treats non-letters as already-revealed (they don't block a win)", () => {
    expect(isSolved("hot dog", ["h", "o", "t", "d", "g"])).toBe(true);
  });
});

describe("renderMasked", () => {
  it("uses underscores for hidden letters and spaces between every slot", () => {
    expect(renderMasked("brain", ["a"])).toBe("_ _ A _ _");
  });
});

describe("renderStage", () => {
  it("returns the pristine gallows when no wrong guesses yet", () => {
    expect(renderStage(0)).toContain("+---+");
    expect(renderStage(0)).not.toContain("O");
  });

  it("draws the full figure once we've maxed out wrong guesses", () => {
    const final = renderStage(6);
    expect(final).toContain("O");
    expect(final).toContain("|");
    expect(final).toContain("/ \\");
  });

  it("clamps inputs above the max so it doesn't crash on overflow", () => {
    expect(renderStage(20)).toBe(renderStage(6));
  });
});

describe("classifyGuess", () => {
  it("recognises single-letter guesses (case-insensitive)", () => {
    expect(classifyGuess("a", 5)).toEqual({ kind: "letter", value: "A" });
    expect(classifyGuess("Z", 5)).toEqual({ kind: "letter", value: "Z" });
  });

  it("recognises full-word guesses only when the length matches", () => {
    expect(classifyGuess("brain", 5)).toEqual({ kind: "word", value: "BRAIN" });
    expect(classifyGuess("brain", 6)).toBeNull();
  });

  it("rejects junk (digits, punctuation, sentences)", () => {
    expect(classifyGuess("hello world", 11)).toBeNull();
    expect(classifyGuess("123", 3)).toBeNull();
    expect(classifyGuess("!", 1)).toBeNull();
  });

  it("trims surrounding whitespace before classifying", () => {
    expect(classifyGuess("  a  ", 5)).toEqual({ kind: "letter", value: "A" });
  });
});

describe("parseControl", () => {
  it("parses well-formed JSON straight through", () => {
    expect(parseControl('{"action":"start","theme":"cuisine"}'))
      .toEqual({ action: "start", theme: "cuisine" });
    expect(parseControl('{"action":"hint"}')).toEqual({ action: "hint" });
  });

  it("accepts loose natural-language strings the brain might emit", () => {
    expect(parseControl("start")).toEqual({ action: "start" });
    expect(parseControl("start cuisine")).toEqual({ action: "start", theme: "cuisine" });
    expect(parseControl("hint")).toEqual({ action: "hint" });
    expect(parseControl("status")).toEqual({ action: "status" });
  });

  it("normalises stop / abandon to quit so callers don't have to", () => {
    expect(parseControl("stop")).toEqual({ action: "quit" });
    expect(parseControl("abandon")).toEqual({ action: "quit" });
    expect(parseControl("quit")).toEqual({ action: "quit" });
  });

  it("falls back to message metadata when the content is junk", () => {
    expect(parseControl("???", { action: "hint" })).toEqual({ action: "hint" });
  });

  it("returns an empty payload when nothing parses and no fallback is given", () => {
    expect(parseControl("???")).toEqual({});
    expect(parseControl("")).toEqual({});
    expect(parseControl(undefined)).toEqual({});
  });
});
