import { describe, expect, it } from "vitest";
import { type Box, mergeHighlightBoxes } from "../../src/reader/highlight-rects";

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

describe("mergeHighlightBoxes", () => {
  it("joins the spans of one line into a single box", () => {
    expect(mergeHighlightBoxes([box(0, 0, 40, 20), box(42, 1, 90, 21)])).toEqual([box(0, 0, 90, 21)]);
  });

  it("splits the overlap between two lines at its midpoint", () => {
    const [upper, lower] = mergeHighlightBoxes([box(0, 0, 100, 24), box(0, 20, 100, 44)]);
    expect(upper).toEqual(box(0, 0, 100, 22));
    expect(lower).toEqual(box(0, 22, 100, 44));
  });

  it("leaves lines that do not overlap alone", () => {
    expect(mergeHighlightBoxes([box(0, 0, 100, 20), box(0, 25, 100, 45)])).toEqual([box(0, 0, 100, 20), box(0, 25, 100, 45)]);
  });

  it("keeps two columns at the same height apart", () => {
    expect(mergeHighlightBoxes([box(0, 0, 100, 20), box(300, 0, 400, 20)])).toHaveLength(2);
  });

  it("reads sides that live on the prototype, as a DOMRect's do", () => {
    class Rect {
      constructor(private readonly sides: Box) {}
      get left() { return this.sides.left; }
      get top() { return this.sides.top; }
      get right() { return this.sides.right; }
      get bottom() { return this.sides.bottom; }
    }
    expect(mergeHighlightBoxes([new Rect(box(5, 5, 50, 20))])).toEqual([box(5, 5, 50, 20)]);
  });

  it("drops empty rects", () => {
    expect(mergeHighlightBoxes([box(0, 0, 0, 20), box(0, 0, 50, 0)])).toEqual([]);
  });
});
