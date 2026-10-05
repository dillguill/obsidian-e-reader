import { describe, expect, it } from "vitest";
import { ScrollChrome, swipeDirection, verticalSwipe } from "../../src/reader/gestures";

describe("swipeDirection", () => {
  it("turns forward on a right-to-left swipe and back on left-to-right", () => {
    expect(swipeDirection(-120, 10, 200)).toBe("next");
    expect(swipeDirection(120, -10, 200)).toBe("prev");
  });

  it("ignores a short, a slow or a mostly vertical drag", () => {
    expect(swipeDirection(-30, 0, 200)).toBeNull();
    expect(swipeDirection(-120, 0, 1200)).toBeNull();
    expect(swipeDirection(-120, 100, 200)).toBeNull();
  });
});

describe("verticalSwipe", () => {
  it("reads a finger moving down as down and up as up", () => {
    expect(verticalSwipe(5, 120, 200)).toBe("down");
    expect(verticalSwipe(-5, -120, 200)).toBe("up");
  });

  it("ignores a sideways or slow drag", () => {
    expect(verticalSwipe(120, 60, 200)).toBeNull();
    expect(verticalSwipe(0, 120, 1200)).toBeNull();
  });
});

describe("ScrollChrome", () => {
  it("hides after scrolling down a little and shows after scrolling up", () => {
    const chrome = new ScrollChrome();
    expect(chrome.update(100, 800)).toBeNull();
    expect(chrome.update(110, 800)).toBeNull();
    expect(chrome.update(130, 800)).toBe("hide");
    expect(chrome.update(120, 800)).toBeNull();
    expect(chrome.update(100, 800)).toBe("show");
  });

  it("always shows at the top", () => {
    const chrome = new ScrollChrome();
    expect(chrome.update(0, 800)).toBe("show");
  });

  it("ignores a jump of more than a screen", () => {
    const chrome = new ScrollChrome();
    chrome.update(100, 800);
    expect(chrome.update(5000, 800)).toBeNull();
    expect(chrome.update(5010, 800)).toBeNull();
  });
});
