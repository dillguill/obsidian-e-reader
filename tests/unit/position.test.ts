import { describe, expect, it } from "vitest";
import { furthestOf, jumpTarget, positionChanged, shouldFlushNow } from "../../src/reader/position";

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

describe("furthestOf", () => {
  it("advances when the reader moves past the stored furthest position", () => {
    expect(furthestOf(["page=10", "page=9"], "page=12")).toBe("page=12");
  });

  it("never moves back when the reader goes back", () => {
    expect(furthestOf(["page=40", "page=39"], "page=5")).toBe("page=40");
  });

  it("seeds from the stored last-read position when there is no furthest yet", () => {
    expect(furthestOf([undefined, "page=30"], "page=2")).toBe("page=30");
  });

  it("keeps a further position synced from another device", () => {
    const fromOtherDevice = "epubcfi(/6/20!/4/2/1:0)";
    expect(furthestOf([fromOtherDevice, "epubcfi(/6/8!/4/2/1:0)"], "epubcfi(/6/10!/4/2/1:0)")).toBe(fromOtherDevice);
  });

  it("ignores stored values that do not parse or belong to the other format", () => {
    expect(furthestOf(["nonsense", 42, "epubcfi(/6/99!/4)"], "page=3")).toBe("page=3");
  });
});

describe("jumpTarget", () => {
  it("offers the furthest position when it lies beyond last-read", () => {
    expect(jumpTarget({ kind: "pdf", page: 5 }, { kind: "pdf", page: 50 })).toEqual({ kind: "pdf", page: 50 });
  });

  it("offers nothing when last-read is the furthest", () => {
    expect(jumpTarget({ kind: "pdf", page: 50 }, { kind: "pdf", page: 50 })).toBeNull();
  });

  it("offers nothing when there is no furthest position", () => {
    expect(jumpTarget({ kind: "pdf", page: 5 }, null)).toBeNull();
  });

  it("offers the furthest position to a book with no last-read position", () => {
    expect(jumpTarget(null, { kind: "pdf", page: 7 })).toEqual({ kind: "pdf", page: 7 });
  });
});
