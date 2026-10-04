import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACE_PDF_MS,
  chapterAt,
  chapterFraction,
  chapterTicks,
  formatDuration,
  nextPace,
  unitsLeft,
} from "../../src/reader/reading-time";

describe("nextPace", () => {
  it("moves toward a plausible sample", () => {
    const next = nextPace(DEFAULT_PACE_PDF_MS, 10, 11, 45_000);
    expect(next).not.toBeNull();
    expect(next as number).toBeLessThan(DEFAULT_PACE_PDF_MS);
    expect(next as number).toBeGreaterThan(45_000);
  });

  it("splits a two-page step across both pages", () => {
    expect(nextPace(60_000, 10, 12, 120_000)).toBe(60_000);
  });

  it("ignores going back, standing still, jumping ahead and long breaks", () => {
    expect(nextPace(60_000, 10, 9, 30_000)).toBeNull();
    expect(nextPace(60_000, 10, 10, 30_000)).toBeNull();
    expect(nextPace(60_000, 10, 40, 30_000)).toBeNull();
    expect(nextPace(60_000, 10, 11, 2_000)).toBeNull();
    expect(nextPace(60_000, 10, 11, 60 * 60_000)).toBeNull();
  });
});

describe("chapterAt", () => {
  const starts = [
    { label: "One", unit: 1 },
    { label: "Two", unit: 20 },
    { label: "Two, part A", unit: 20 },
    { label: "Unplaced", unit: null },
    { label: "Three", unit: 50 },
  ];

  it("finds the chapter the reader is in and where it ends", () => {
    expect(chapterAt(starts, 10, 100)).toEqual({ label: "One", start: 1, end: 20 });
  });

  it("takes the last entry at a shared start, ending at the next later one", () => {
    expect(chapterAt(starts, 25, 100)).toEqual({ label: "Two, part A", start: 20, end: 50 });
  });

  it("runs the last chapter to the end of the book", () => {
    expect(chapterAt(starts, 60, 100)).toEqual({ label: "Three", start: 50, end: 101 });
  });

  it("is null before the first entry or with none placed", () => {
    expect(chapterAt([{ label: "Late", unit: 5 }], 2, 10)).toBeNull();
    expect(chapterAt([{ label: "x", unit: null }], 2, 10)).toBeNull();
  });
});

describe("chapter progress", () => {
  it("is the share of the chapter behind the reader", () => {
    expect(chapterFraction({ label: "", start: 10, end: 20 }, 15)).toBe(0.5);
  });

  it("counts the unit on screen as half read", () => {
    expect(unitsLeft(19, 20)).toBe(0.5);
    expect(unitsLeft(25, 20)).toBe(0);
  });
});

describe("chapterTicks", () => {
  it("marks each top-level chapter after the first along the bar", () => {
    const starts = [
      { label: "One", unit: 1, depth: 0 },
      { label: "One, part A", unit: 5, depth: 1 },
      { label: "Two", unit: 51, depth: 0 },
      { label: "Two again", unit: 51, depth: 0 },
      { label: "Unplaced", unit: null, depth: 0 },
    ];
    expect(chapterTicks(starts, 101)).toEqual([0.5]);
  });

  it("has nothing to mark in a one-unit book", () => {
    expect(chapterTicks([{ label: "x", unit: 1 }], 1)).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("reads naturally at every scale", () => {
    expect(formatDuration(20_000)).toBe("under a minute");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
    expect(formatDuration(185 * 60_000)).toBe("3 h 5 min");
  });
});
