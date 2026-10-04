import { describe, expect, it } from "vitest";
import {
  clampPageInput,
  pageLabel,
  pageValue,
  progressLabel,
  targetFromInput,
  toolbarState,
} from "../../src/reader/toolbar-model";

const pdfPages = { current: 12, total: 340, unit: "page" as const };
const epubLocations = { current: 148, total: 2310, unit: "location" as const };

describe("pageLabel", () => {
  it("reads `of N` for a fixed-page book", () => {
    expect(pageLabel(pdfPages)).toBe("of 340");
  });

  // Locations are epub.js's own index and mean nothing to a reader.
  it("reads `%` for a reflowable book", () => {
    expect(pageLabel(epubLocations)).toBe("%");
  });

  it("is empty when the engine cannot say where it is yet", () => {
    expect(pageLabel(null)).toBe("");
  });
});

describe("pageValue", () => {
  it("is the current page for a fixed-page book", () => {
    expect(pageValue(pdfPages, 3)).toBe("12");
  });

  it("is the rounded percentage for a reflowable book", () => {
    expect(pageValue(epubLocations, 6.4)).toBe("6");
  });

  it("is empty with no page state, so the box shows nothing rather than 0", () => {
    expect(pageValue(null, 0)).toBe("");
  });
});

describe("clampPageInput", () => {
  it("accepts a number inside the document", () => {
    expect(clampPageInput("12", 340)).toBe(12);
  });

  it("ignores surrounding whitespace", () => {
    expect(clampPageInput("  12 ", 340)).toBe(12);
  });

  it("clamps below the minimum and above the maximum rather than refusing", () => {
    expect(clampPageInput("0", 340)).toBe(1);
    expect(clampPageInput("-5", 340)).toBe(1);
    expect(clampPageInput("9999", 340)).toBe(340);
    expect(clampPageInput("0", 100, 0)).toBe(0);
  });

  it("rounds a fractional entry", () => {
    expect(clampPageInput("12.6", 340)).toBe(13);
  });

  it("rejects text, so the box can be restored to its previous value", () => {
    expect(clampPageInput("", 340)).toBeNull();
    expect(clampPageInput("twelve", 340)).toBeNull();
    expect(clampPageInput("NaN", 340)).toBeNull();
  });

  it("rejects any input when the document has no pages", () => {
    expect(clampPageInput("1", 0)).toBeNull();
  });
});

describe("targetFromInput", () => {
  it("passes a page number through", () => {
    expect(targetFromInput(40, pdfPages)).toBe(40);
  });

  it("turns a percentage into a location", () => {
    expect(targetFromInput(0, epubLocations)).toBe(1);
    expect(targetFromInput(100, epubLocations)).toBe(2310);
    expect(targetFromInput(50, epubLocations)).toBe(1156);
  });
});

describe("toolbarState", () => {
  const base = { pages: pdfPages, bookmarked: false, progress: 4 };

  it("disables the page box until the engine reports a page state", () => {
    expect(toolbarState(base).pageEnabled).toBe(true);
    expect(toolbarState({ ...base, pages: null }).pageEnabled).toBe(false);
  });

  it("carries the label and value through for the view to render", () => {
    const state = toolbarState(base);
    expect(state.pageValue).toBe("12");
    expect(state.pageLabel).toBe("of 340");
    expect(state.pageName).toBe("Page");
  });

  // The page box is a number input whose `max` bounds a typed entry, and
  // clampPageInput reads that same bound back off it.
  it("bounds a page box by the page count and a percentage box by 0–100", () => {
    expect(toolbarState(base)).toMatchObject({ pageMax: 340, pageMin: 1 });
    expect(toolbarState({ ...base, pages: epubLocations })).toMatchObject({ pageMax: 100, pageMin: 0, pageName: "Percent" });
    expect(toolbarState({ ...base, pages: null }).pageMax).toBe(0);
  });

  it("passes the bookmark toggle through", () => {
    expect(toolbarState({ ...base, bookmarked: true }).bookmarked).toBe(true);
    expect(toolbarState(base).bookmarked).toBe(false);
  });

  it("disables the page buttons only at the ends of a known range", () => {
    expect(toolbarState(base).canGoBack).toBe(true);
    expect(toolbarState(base).canGoForward).toBe(true);
    expect(toolbarState({ ...base, pages: { current: 1, total: 340, unit: "page" } }).canGoBack).toBe(false);
    expect(toolbarState({ ...base, pages: { current: 340, total: 340, unit: "page" } }).canGoForward).toBe(false);
  });

  it("keeps the page buttons usable while the engine cannot say where it is", () => {
    const state = toolbarState({ ...base, pages: null });
    expect(state.canGoBack).toBe(true);
    expect(state.canGoForward).toBe(true);
  });
});

describe("progressLabel", () => {
  it("is empty until the engine can place the reader", () => {
    expect(progressLabel(null, 0)).toBe("");
  });

  it("rounds and clamps", () => {
    const pages = { current: 1, total: 10, unit: "page" as const };
    expect(progressLabel(pages, 41.6)).toBe("42%");
    expect(progressLabel(pages, 140)).toBe("100%");
    expect(progressLabel(pages, Number.NaN)).toBe("");
  });
});
