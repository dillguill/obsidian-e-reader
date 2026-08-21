import { describe, expect, it } from "vitest";
import { clampProgress, fractionToPercent, pdfPageToPercent } from "../../src/reader/progress";

describe("clampProgress", () => {
  it("passes an in-range value through unchanged", () => {
    expect(clampProgress(42)).toBe(42);
  });

  it("clamps a value above 100 down to 100", () => {
    expect(clampProgress(150)).toBe(100);
  });

  it("clamps a negative value up to 0", () => {
    expect(clampProgress(-5)).toBe(0);
  });

  it("treats NaN as 0", () => {
    expect(clampProgress(NaN)).toBe(0);
  });

  it("treats Infinity as 0 rather than clamping to 100", () => {
    expect(clampProgress(Infinity)).toBe(0);
  });
});

describe("fractionToPercent", () => {
  it("converts a 0–1 fraction to a rounded 0–100 percent", () => {
    expect(fractionToPercent(0)).toBe(0);
    expect(fractionToPercent(1)).toBe(100);
    expect(fractionToPercent(0.5)).toBe(50);
  });

  it("rounds to the nearest whole percent", () => {
    expect(fractionToPercent(0.333)).toBe(33);
    expect(fractionToPercent(0.336)).toBe(34);
  });

  it("clamps a fraction outside 0–1", () => {
    expect(fractionToPercent(1.2)).toBe(100);
    expect(fractionToPercent(-0.2)).toBe(0);
  });
});

describe("pdfPageToPercent", () => {
  it("computes the percentage of pages read so far", () => {
    expect(pdfPageToPercent(1, 4)).toBe(25);
    expect(pdfPageToPercent(4, 4)).toBe(100);
  });

  it("returns 0 for a zero- or negative-page document rather than dividing by zero", () => {
    expect(pdfPageToPercent(1, 0)).toBe(0);
    expect(pdfPageToPercent(1, -3)).toBe(0);
  });

  it("clamps a page number past the document's end", () => {
    expect(pdfPageToPercent(10, 4)).toBe(100);
  });
});
