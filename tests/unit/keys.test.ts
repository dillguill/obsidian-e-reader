import { describe, expect, it } from "vitest";
import { keyAction } from "../../src/reader/keys";

const press = (key: string, modifiers: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...modifiers,
});

describe("keyAction", () => {
  it("turns forward on Right and PageDown", () => {
    expect(keyAction(press("ArrowRight"))).toBe("next");
    expect(keyAction(press("PageDown"))).toBe("next");
  });

  it("turns back on Left and PageUp", () => {
    expect(keyAction(press("ArrowLeft"))).toBe("prev");
    expect(keyAction(press("PageUp"))).toBe("prev");
  });

  it("dismisses on Escape, even with Shift held", () => {
    expect(keyAction(press("Escape"))).toBe("dismiss");
    expect(keyAction(press("Escape", { shiftKey: true }))).toBe("dismiss");
  });

  // Up, Down and Space already scroll a scrolled book; taking them would
  // make the keyboard fight the reader.
  it("leaves scrolling keys to the platform", () => {
    expect(keyAction(press("ArrowDown"))).toBeNull();
    expect(keyAction(press("ArrowUp"))).toBeNull();
    expect(keyAction(press(" "))).toBeNull();
  });

  it("ignores Shift+arrow, which extends a selection", () => {
    expect(keyAction(press("ArrowRight", { shiftKey: true }))).toBeNull();
  });

  it("ignores any press with a hotkey modifier", () => {
    expect(keyAction(press("ArrowRight", { ctrlKey: true }))).toBeNull();
    expect(keyAction(press("ArrowLeft", { metaKey: true }))).toBeNull();
    expect(keyAction(press("Escape", { altKey: true }))).toBeNull();
  });
});
