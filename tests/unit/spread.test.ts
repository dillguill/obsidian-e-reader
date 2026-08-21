import { describe, expect, it } from "vitest";
import { isSpreadMode, spreadRows } from "../../src/reader/spread";

describe("spreadRows", () => {
  it("gives one page per row in single mode", () => {
    expect(spreadRows(4, "single")).toEqual([[1], [2], [3], [4]]);
  });

  it("pairs odd-first: the cover stands alone, then 2-3, 4-5", () => {
    expect(spreadRows(6, "odd")).toEqual([[1], [2, 3], [4, 5], [6]]);
  });

  it("pairs even-first: 1-2, 3-4", () => {
    expect(spreadRows(6, "even")).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("leaves a lone trailing page in its own row", () => {
    expect(spreadRows(5, "even")).toEqual([[1, 2], [3, 4], [5]]);
    expect(spreadRows(5, "odd")).toEqual([[1], [2, 3], [4, 5]]);
  });

  it("covers every page exactly once, in order, for every mode", () => {
    for (const mode of ["single", "odd", "even"] as const) {
      for (const total of [1, 2, 3, 7, 20]) {
        const flat = spreadRows(total, mode).flat();
        expect(flat).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      }
    }
  });

  it("returns nothing for a document with no pages", () => {
    expect(spreadRows(0, "single")).toEqual([]);
    expect(spreadRows(-3, "even")).toEqual([]);
  });
});

describe("isSpreadMode", () => {
  it("accepts the three modes", () => {
    expect(isSpreadMode("single")).toBe(true);
    expect(isSpreadMode("odd")).toBe(true);
    expect(isSpreadMode("even")).toBe(true);
  });

  it("rejects anything else, so a corrupt data.json falls back to a default", () => {
    expect(isSpreadMode("double")).toBe(false);
    expect(isSpreadMode(2)).toBe(false);
    expect(isSpreadMode(null)).toBe(false);
  });
});
