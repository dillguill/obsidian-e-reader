import { describe, it, expect } from "vitest";
import { decideOpenTarget } from "../../src/library/open-book";

const NONE = { ctrlKey: false, metaKey: false, altKey: false };

describe("decideOpenTarget", () => {
  it("opens in the same tab for a plain click", () => {
    expect(decideOpenTarget({ ...NONE })).toBe("same-tab");
  });

  it("opens in the same tab for plain keyboard activation (no button field)", () => {
    expect(decideOpenTarget({ ...NONE })).toBe("same-tab");
  });

  it("opens in a new tab with Ctrl held", () => {
    expect(decideOpenTarget({ ...NONE, ctrlKey: true })).toBe("new-tab");
  });

  it("opens in a new tab with Cmd (metaKey) held", () => {
    expect(decideOpenTarget({ ...NONE, metaKey: true })).toBe("new-tab");
  });

  it("opens in a split with Ctrl+Alt held", () => {
    expect(decideOpenTarget({ ...NONE, ctrlKey: true, altKey: true })).toBe("split");
  });

  it("opens in a split with Cmd+Alt held", () => {
    expect(decideOpenTarget({ ...NONE, metaKey: true, altKey: true })).toBe("split");
  });

  it("opens in the same tab for Alt alone, without a primary modifier", () => {
    expect(decideOpenTarget({ ...NONE, altKey: true })).toBe("same-tab");
  });

  it("opens in a new tab for a middle click, regardless of modifiers", () => {
    expect(decideOpenTarget({ ...NONE, button: 1 })).toBe("new-tab");
  });

  it("treats a left click (button 0) as an ordinary click", () => {
    expect(decideOpenTarget({ ...NONE, button: 0 })).toBe("same-tab");
  });
});
