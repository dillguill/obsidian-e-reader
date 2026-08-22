import { describe, expect, it } from "vitest";
import { MAX_SCALE, MIN_SCALE } from "../../src/reader/zoom";
import { PINCH_THRESHOLD, pinchDistance, pinchScale, isPinchWorthApplying } from "../../src/reader/pinch";

describe("pinchDistance", () => {
  it("measures the gap between two touch points", () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("is zero for two fingers in the same place", () => {
    expect(pinchDistance({ x: 7, y: 7 }, { x: 7, y: 7 })).toBe(0);
  });
});

describe("pinchScale", () => {
  it("scales in proportion to how far the fingers moved apart", () => {
    expect(pinchScale(1, 100, 200)).toBe(2);
    expect(pinchScale(1, 200, 100)).toBe(0.5);
  });

  it("builds on the scale the gesture started from", () => {
    expect(pinchScale(1.5, 100, 200)).toBe(3);
  });

  it("stays inside the supported zoom range", () => {
    expect(pinchScale(2, 100, 1000)).toBe(MAX_SCALE);
    expect(pinchScale(1, 1000, 10)).toBe(MIN_SCALE);
  });

  // A gesture that begins with the fingers together would divide by zero and
  // fling the scale to its limit.
  it("keeps the starting scale when the gesture had no width to begin with", () => {
    expect(pinchScale(1.25, 0, 200)).toBe(1.25);
  });
});

describe("isPinchWorthApplying", () => {
  it("ignores a change too small to be deliberate", () => {
    expect(isPinchWorthApplying(1, 1)).toBe(false);
    expect(isPinchWorthApplying(1, 1 + PINCH_THRESHOLD / 2)).toBe(false);
  });

  it("accepts a change past the threshold, in either direction", () => {
    expect(isPinchWorthApplying(1, 1 + PINCH_THRESHOLD * 2)).toBe(true);
    expect(isPinchWorthApplying(1, 1 - PINCH_THRESHOLD * 2)).toBe(true);
  });
});
