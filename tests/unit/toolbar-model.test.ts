import { describe, expect, it } from "vitest";
import { MAX_SCALE, MIN_SCALE } from "../../src/reader/zoom";
import { clampPageInput, pageLabel, pageValue, toolbarState } from "../../src/reader/toolbar-model";

describe("pageLabel", () => {
  it("reads `of N` for a fixed-page book", () => {
    expect(pageLabel({ current: 12, total: 340, unit: "page" })).toBe("of 340");
  });

  it("reads the same for a reflowable book's location index", () => {
    expect(pageLabel({ current: 148, total: 2310, unit: "location" })).toBe("of 2310");
  });

  it("is empty when the engine cannot say where it is yet", () => {
    expect(pageLabel(null)).toBe("");
  });
});

describe("pageValue", () => {
  it("is the current number as a string", () => {
    expect(pageValue({ current: 12, total: 340, unit: "page" })).toBe("12");
  });

  it("is empty with no page state, so the box shows nothing rather than 0", () => {
    expect(pageValue(null)).toBe("");
  });
});

describe("clampPageInput", () => {
  it("accepts a number inside the document", () => {
    expect(clampPageInput("12", 340)).toBe(12);
  });

  it("ignores surrounding whitespace", () => {
    expect(clampPageInput("  12 ", 340)).toBe(12);
  });

  it("clamps below 1 and above the total rather than refusing", () => {
    expect(clampPageInput("0", 340)).toBe(1);
    expect(clampPageInput("-5", 340)).toBe(1);
    expect(clampPageInput("9999", 340)).toBe(340);
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

describe("toolbarState", () => {
  const base = {
    pages: { current: 12, total: 340, unit: "page" as const },
    scale: 1,
    highlightMode: false,
    activeType: "idea",
    activeColor: "#ffd76e",
    bookmarked: false,
  };

  it("enables both zoom buttons in the middle of the range", () => {
    const state = toolbarState(base);
    expect(state.canZoomIn).toBe(true);
    expect(state.canZoomOut).toBe(true);
  });

  it("disables zoom out at the minimum and zoom in at the maximum", () => {
    expect(toolbarState({ ...base, scale: MIN_SCALE }).canZoomOut).toBe(false);
    expect(toolbarState({ ...base, scale: MIN_SCALE }).canZoomIn).toBe(true);
    expect(toolbarState({ ...base, scale: MAX_SCALE }).canZoomIn).toBe(false);
    expect(toolbarState({ ...base, scale: MAX_SCALE }).canZoomOut).toBe(true);
  });

  it("disables the page box until the engine reports a page state", () => {
    expect(toolbarState(base).pageEnabled).toBe(true);
    expect(toolbarState({ ...base, pages: null }).pageEnabled).toBe(false);
  });

  it("carries the label and value through for the view to render", () => {
    const state = toolbarState(base);
    expect(state.pageValue).toBe("12");
    expect(state.pageLabel).toBe("of 340");
  });

  // The page box is a number input whose `max` bounds a typed entry, and
  // clampPageInput reads that same total back off it. Without a total the box
  // would reject every entry it was given.
  it("reports the total so the page box can bound what is typed into it", () => {
    expect(toolbarState(base).pageTotal).toBe(340);
    expect(toolbarState({ ...base, pages: null }).pageTotal).toBe(0);
  });

  it("passes the highlight mode and bookmark toggles through", () => {
    const state = toolbarState({ ...base, highlightMode: true, bookmarked: true });
    expect(state.highlightMode).toBe(true);
    expect(state.bookmarked).toBe(true);
  });

  it("carries the armed type and its colour, for the button and the picker", () => {
    const state = toolbarState({ ...base, activeType: "question", activeColor: "#7ec4f5" });
    expect(state.activeType).toBe("question");
    expect(state.activeColor).toBe("#7ec4f5");
  });

  // Every type can be deleted from the settings, and highlight mode then has
  // nothing to write; the button has to say so rather than arm into nothing.
  it("cannot be in highlight mode with no type to write", () => {
    const state = toolbarState({ ...base, highlightMode: true, activeType: "", activeColor: "" });
    expect(state.highlightMode).toBe(false);
  });
});
