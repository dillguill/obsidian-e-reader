import { describe, expect, it } from "vitest";
import { positionChanged, shouldFlushNow } from "../../src/reader/position";

describe("positionChanged", () => {
  it("is a change when nothing has been written yet (null previous)", () => {
    expect(positionChanged(null, { progress: 0, locator: "page=1" })).toBe(true);
  });

  it("is not a change when progress and locator are both identical", () => {
    const position = { progress: 50, locator: "page=12" };
    expect(positionChanged({ ...position }, { ...position })).toBe(false);
  });

  it("is a change when only progress differs", () => {
    expect(positionChanged({ progress: 50, locator: "page=12" }, { progress: 51, locator: "page=12" })).toBe(true);
  });

  it("is a change when only the locator differs", () => {
    expect(positionChanged({ progress: 50, locator: "page=12" }, { progress: 50, locator: "page=13" })).toBe(true);
  });
});

describe("shouldFlushNow", () => {
  it("does not flush before the minimum interval has elapsed", () => {
    expect(shouldFlushNow(500, 2000)).toBe(false);
  });

  it("flushes once the minimum interval has elapsed", () => {
    expect(shouldFlushNow(2000, 2000)).toBe(true);
  });

  it("flushes once well past the minimum interval", () => {
    expect(shouldFlushNow(5000, 2000)).toBe(true);
  });

  it("always flushes immediately when debouncing is disabled (interval <= 0)", () => {
    expect(shouldFlushNow(0, 0)).toBe(true);
    expect(shouldFlushNow(0, -1)).toBe(true);
  });
});
