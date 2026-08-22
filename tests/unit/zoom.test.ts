import { describe, expect, it } from "vitest";
import { MAX_SCALE, MIN_SCALE, SCALE_STEPS, fitRowSize, fitScale, stepScale } from "../../src/reader/zoom";

describe("SCALE_STEPS", () => {
  it("is sorted ascending and spans MIN_SCALE to MAX_SCALE", () => {
    expect([...SCALE_STEPS].sort((a, b) => a - b)).toEqual([...SCALE_STEPS]);
    expect(SCALE_STEPS[0]).toBe(MIN_SCALE);
    expect(SCALE_STEPS[SCALE_STEPS.length - 1]).toBe(MAX_SCALE);
  });

  it("includes 1 so that actual size is reachable by stepping", () => {
    expect(SCALE_STEPS).toContain(1);
  });
});

describe("stepScale", () => {
  it("moves to the next step up", () => {
    expect(stepScale(1, 1)).toBe(1.1);
  });

  it("moves to the next step down", () => {
    expect(stepScale(1, -1)).toBe(0.9);
  });

  it("clamps at the top", () => {
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(stepScale(99, 1)).toBe(MAX_SCALE);
  });

  it("clamps at the bottom", () => {
    expect(stepScale(MIN_SCALE, -1)).toBe(MIN_SCALE);
    expect(stepScale(0.01, -1)).toBe(MIN_SCALE);
  });

  it("snaps a scale that sits between steps to the next step in that direction", () => {
    // 1.5 is a step; 1.35 is not. Up from 1.35 is 1.5, down from 1.35 is 1.25.
    expect(stepScale(1.35, 1)).toBe(1.5);
    expect(stepScale(1.35, -1)).toBe(1.25);
  });

  it("treats a non-finite current scale as 1", () => {
    expect(stepScale(Number.NaN, 1)).toBe(1.1);
    expect(stepScale(Number.POSITIVE_INFINITY, -1)).toBe(0.9);
  });
});

describe("fitScale", () => {
  it("fits a page to the available width", () => {
    expect(fitScale({ width: 600, height: 1000 }, { width: 300, height: 400 }, "width")).toBe(2);
  });

  it("fits a page to the available height", () => {
    expect(fitScale({ width: 600, height: 1000 }, { width: 300, height: 400 }, "height")).toBe(2.5);
  });

  it("clamps the result into the supported scale range", () => {
    expect(fitScale({ width: 100000, height: 100 }, { width: 10, height: 10 }, "width")).toBe(MAX_SCALE);
    expect(fitScale({ width: 1, height: 100 }, { width: 10000, height: 10 }, "width")).toBe(MIN_SCALE);
  });

  it("returns 1 rather than dividing by zero when the page has no size", () => {
    expect(fitScale({ width: 600, height: 1000 }, { width: 0, height: 0 }, "width")).toBe(1);
  });

  it("returns 1 when the container has not been laid out yet", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 300, height: 400 }, "width")).toBe(1);
  });
});

describe("fitRowSize", () => {
  const page = { width: 300, height: 400 };

  it("is just the page when a row holds one", () => {
    expect(fitRowSize(page, 1, 8)).toEqual(page);
  });

  // Fit-width in a spread mode has to fit the whole row — two pages and the
  // gap between them — or a two-page spread ends up twice as wide as the pane.
  it("counts both pages and the gap when a row holds two", () => {
    expect(fitRowSize(page, 2, 8)).toEqual({ width: 608, height: 400 });
  });

  it("adds no gap for a single page even when one is configured", () => {
    expect(fitRowSize(page, 1, 40).width).toBe(300);
  });

  it("treats a non-finite gap as none rather than poisoning the width", () => {
    expect(fitRowSize(page, 2, Number.NaN).width).toBe(600);
  });
});

describe("fitScale", () => {
  const page = { width: 500, height: 1000 };

  it("fits the width, ignoring how tall the page is", () => {
    expect(fitScale({ width: 1000, height: 100 }, page, "width")).toBe(2);
  });

  it("fits the height, ignoring how wide the page is", () => {
    expect(fitScale({ width: 100, height: 500 }, page, "height")).toBe(0.5);
  });

  // pdf.js's own page-fit: Math.min(pageWidthScale, pageHeightScale).
  it("fits the whole page inside both axes, taking whichever binds", () => {
    // Width would allow 2x, height only 0.5x — the page has to fit both.
    expect(fitScale({ width: 1000, height: 500 }, page, "page")).toBe(0.5);
    // and the other way round
    expect(fitScale({ width: 250, height: 2000 }, page, "page")).toBe(0.5);
  });

  it("never exceeds the zoom range", () => {
    expect(fitScale({ width: 100000, height: 100000 }, page, "page")).toBe(MAX_SCALE);
    expect(fitScale({ width: 1, height: 1 }, page, "page")).toBe(MIN_SCALE);
  });

  it("falls back to 1 before the container has been laid out", () => {
    expect(fitScale({ width: 0, height: 0 }, page, "width")).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, page, "page")).toBe(1);
  });
});
