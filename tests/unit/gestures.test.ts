import { describe, expect, it } from "vitest";
import { swipeDirection, verticalSwipe } from "../../src/reader/gestures";

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
