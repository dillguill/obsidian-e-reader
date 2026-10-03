import { describe, expect, it } from "vitest";
import { POPUP_GAP, placePopup } from "../../src/reader/popup-position";

const bounds = { left: 100, top: 50, right: 700, bottom: 650 };
const size = { width: 120, height: 30 };
const anchor = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe("placePopup", () => {
  it("centres above the selection, relative to the bounds", () => {
    const at = placePopup(anchor(300, 300, 400, 320), bounds, size, "above");
    expect(at).toEqual({ left: 350 - 60 - 100, top: 300 - POPUP_GAP - 30 - 50 });
  });

  it("goes below when that is preferred", () => {
    const at = placePopup(anchor(300, 300, 400, 320), bounds, size, "below");
    expect(at?.top).toBe(320 + POPUP_GAP - 50);
  });

  it("flips below when there is no room above", () => {
    const at = placePopup(anchor(300, 60, 400, 80), bounds, size, "above");
    expect(at?.top).toBe(80 + POPUP_GAP - 50);
  });

  it("flips above when there is no room below", () => {
    const at = placePopup(anchor(300, 620, 400, 640), bounds, size, "below");
    expect(at?.top).toBe(620 - POPUP_GAP - 30 - 50);
  });

  it("stays inside the bounds horizontally near either edge", () => {
    expect(placePopup(anchor(100, 300, 110, 320), bounds, size, "above")?.left).toBe(POPUP_GAP);
    expect(placePopup(anchor(690, 300, 700, 320), bounds, size, "above")?.left).toBe(600 - POPUP_GAP - 120);
  });

  it("pins inside the bounds when the selection is taller than the pane", () => {
    const at = placePopup(anchor(300, 40, 400, 660), bounds, size, "above");
    expect(at?.top).toBe(POPUP_GAP);
  });

  it("gives nothing once the selection has scrolled out of view", () => {
    expect(placePopup(anchor(300, 0, 400, 40), bounds, size, "above")).toBeNull();
    expect(placePopup(anchor(300, 700, 400, 720), bounds, size, "above")).toBeNull();
  });
});
