import { describe, expect, it } from "vitest";
import {
  countMatches,
  firstMatch,
  matchIndex,
  matchOffsets,
  stepMatch,
  totalMatches,
} from "../../src/reader/find-text";

const query = (text: string, caseSensitive = false) => ({
  query: text,
  caseSensitive,
  highlightAll: true,
});

describe("matchOffsets", () => {
  it("finds every occurrence, in order", () => {
    expect(matchOffsets("a whale, a whale!", query("whale"))).toEqual([2, 11]);
  });

  it("ignores case by default", () => {
    expect(matchOffsets("Whale whale WHALE", query("whale"))).toEqual([0, 6, 12]);
  });

  it("respects case when asked to", () => {
    expect(matchOffsets("Whale whale WHALE", query("whale", true))).toEqual([6]);
  });

  // The text being searched has already had its whitespace collapsed, so a
  // query typed with a line break in it would otherwise never match.
  it("normalises the query the same way the text was normalised", () => {
    expect(matchOffsets("Call me Ishmael.", query("  Call\n  me "))).toEqual([0]);
  });

  it("does not report overlapping matches twice", () => {
    // "aaaa" holds two non-overlapping "aa", not three.
    expect(matchOffsets("aaaa", query("aa"))).toEqual([0, 2]);
  });

  it("has nothing to find for an empty or whitespace-only query", () => {
    expect(matchOffsets("Call me Ishmael.", query(""))).toEqual([]);
    expect(matchOffsets("Call me Ishmael.", query("   "))).toEqual([]);
  });

  it("has nothing to find in empty text", () => {
    expect(matchOffsets("", query("whale"))).toEqual([]);
  });
});

describe("countMatches", () => {
  it("counts what matchOffsets would return", () => {
    expect(countMatches("a whale, a whale!", query("whale"))).toBe(2);
    expect(countMatches("a whale", query("narwhal"))).toBe(0);
  });
});

describe("totalMatches", () => {
  it("adds up the per-page counts", () => {
    expect(totalMatches([2, 0, 3])).toBe(5);
  });

  it("treats a page the scan has not reached yet as none", () => {
    const counts: number[] = [];
    counts[2] = 4;
    expect(totalMatches(counts)).toBe(4);
  });
});

describe("matchIndex", () => {
  it("numbers a match by how many come before it in page order", () => {
    const counts = [2, 0, 3];
    expect(matchIndex(counts, { page: 1, nth: 0 })).toBe(0);
    expect(matchIndex(counts, { page: 1, nth: 1 })).toBe(1);
    expect(matchIndex(counts, { page: 3, nth: 0 })).toBe(2);
    expect(matchIndex(counts, { page: 3, nth: 2 })).toBe(4);
  });
});

describe("firstMatch", () => {
  // The scan starts at the page being read so the first result is the nearest
  // one, not the first in the book.
  it("finds the first match at or after the starting page", () => {
    expect(firstMatch([1, 0, 2], 2)).toEqual({ page: 3, nth: 0 });
  });

  it("wraps to the top of the book when nothing follows", () => {
    expect(firstMatch([1, 0, 0], 2)).toEqual({ page: 1, nth: 0 });
  });

  it("is null when there is nothing to find", () => {
    expect(firstMatch([0, 0, 0], 1)).toBeNull();
  });
});

describe("stepMatch", () => {
  const counts = [2, 0, 1];

  it("moves to the next match on the same page", () => {
    expect(stepMatch(counts, { page: 1, nth: 0 }, false)).toEqual({ page: 1, nth: 1 });
  });

  it("skips over pages with no matches", () => {
    expect(stepMatch(counts, { page: 1, nth: 1 }, false)).toEqual({ page: 3, nth: 0 });
  });

  it("wraps from the last match round to the first", () => {
    expect(stepMatch(counts, { page: 3, nth: 0 }, false)).toEqual({ page: 1, nth: 0 });
  });

  it("goes backwards, wrapping to the last match", () => {
    expect(stepMatch(counts, { page: 1, nth: 0 }, true)).toEqual({ page: 3, nth: 0 });
    expect(stepMatch(counts, { page: 3, nth: 0 }, true)).toEqual({ page: 1, nth: 1 });
  });

  it("stays put when it is the only match", () => {
    expect(stepMatch([1], { page: 1, nth: 0 }, false)).toEqual({ page: 1, nth: 0 });
    expect(stepMatch([1], { page: 1, nth: 0 }, true)).toEqual({ page: 1, nth: 0 });
  });

  it("is null when there is nothing to step through", () => {
    expect(stepMatch([0, 0], { page: 1, nth: 0 }, false)).toBeNull();
  });
});
