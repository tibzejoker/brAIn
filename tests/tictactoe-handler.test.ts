import { describe, it, expect } from "vitest";

import {
  parseCell,
  emptyCells,
  checkWin,
  renderBoard,
  pickFallbackMove,
  parseControl,
  type Cell,
} from "../../storeprojects/brAIn-games/nodes/tictactoe/src/handler";

const E = (): Cell[] => Array<Cell>(9).fill(null);

describe("parseCell", () => {
  it("converts numpad-style 1-9 to 0-based index", () => {
    expect(parseCell("1")).toBe(0);
    expect(parseCell("5")).toBe(4);
    expect(parseCell("9")).toBe(8);
  });

  it("trims surrounding whitespace", () => {
    expect(parseCell("  5  ")).toBe(4);
  });

  it("rejects anything that isn't a single 1-9 digit", () => {
    expect(parseCell("0")).toBeNull();
    expect(parseCell("10")).toBeNull();
    expect(parseCell("a")).toBeNull();
    expect(parseCell("")).toBeNull();
    expect(parseCell("five")).toBeNull();
  });
});

describe("checkWin", () => {
  it("detects a horizontal row", () => {
    const b = E(); b[0] = "X"; b[1] = "X"; b[2] = "X";
    expect(checkWin(b)).toEqual({ mark: "X", line: [0, 1, 2] });
  });

  it("detects a vertical column", () => {
    const b = E(); b[1] = "O"; b[4] = "O"; b[7] = "O";
    expect(checkWin(b)).toEqual({ mark: "O", line: [1, 4, 7] });
  });

  it("detects both diagonals", () => {
    const main = E(); main[0] = "X"; main[4] = "X"; main[8] = "X";
    expect(checkWin(main)).toEqual({ mark: "X", line: [0, 4, 8] });
    const anti = E(); anti[2] = "O"; anti[4] = "O"; anti[6] = "O";
    expect(checkWin(anti)).toEqual({ mark: "O", line: [2, 4, 6] });
  });

  it("returns null on an empty board", () => {
    expect(checkWin(E())).toBeNull();
  });

  it("returns null when two marks share a line", () => {
    const b = E(); b[0] = "X"; b[1] = "X"; b[2] = "O";
    expect(checkWin(b)).toBeNull();
  });
});

describe("emptyCells", () => {
  it("lists every still-free index", () => {
    const b = E(); b[0] = "X"; b[4] = "O";
    expect(emptyCells(b)).toEqual([1, 2, 3, 5, 6, 7, 8]);
  });

  it("returns an empty list on a full board", () => {
    const b: Cell[] = ["X", "O", "X", "X", "O", "O", "O", "X", "X"];
    expect(emptyCells(b)).toEqual([]);
  });
});

describe("renderBoard", () => {
  it("uses cell numbers for empty squares and marks for taken ones", () => {
    const b = E(); b[4] = "X"; b[0] = "O";
    expect(renderBoard(b)).toBe(
      [
        " O | 2 | 3",
        "-----------",
        " 4 | X | 6",
        "-----------",
        " 7 | 8 | 9",
      ].join("\n"),
    );
  });
});

describe("pickFallbackMove", () => {
  it("prefers the center when free", () => {
    expect(pickFallbackMove(E())).toBe(4);
  });

  it("falls to a corner when center is taken", () => {
    const b = E(); b[4] = "X";
    expect([0, 2, 6, 8]).toContain(pickFallbackMove(b));
  });

  it("returns an edge when only edges remain", () => {
    const b: Cell[] = ["X", null, "O", null, "X", null, "X", null, "O"];
    expect([1, 3, 5, 7]).toContain(pickFallbackMove(b));
  });
});

describe("parseControl", () => {
  it("parses well-formed JSON", () => {
    expect(parseControl('{"action":"start"}')).toEqual({ action: "start" });
    expect(parseControl('{"action":"start","mark":"O"}')).toEqual({ action: "start", mark: "O" });
  });

  it("accepts loose strings (`start`, `start O`, `quit`)", () => {
    expect(parseControl("start")).toEqual({ action: "start" });
    expect(parseControl("start O")).toEqual({ action: "start", mark: "O" });
    expect(parseControl("start X")).toEqual({ action: "start", mark: "X" });
    expect(parseControl("quit")).toEqual({ action: "quit" });
  });

  it("normalises stop / abandon to quit", () => {
    expect(parseControl("stop")).toEqual({ action: "quit" });
    expect(parseControl("abandon")).toEqual({ action: "quit" });
  });

  it("returns an empty payload for junk content", () => {
    expect(parseControl("???")).toEqual({});
    expect(parseControl(undefined)).toEqual({});
  });
});
