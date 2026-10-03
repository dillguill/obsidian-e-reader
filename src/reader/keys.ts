// What a key press means to the reader.
//
// Kept as a pure mapping so it can be tested without a DOM
// (tests/unit/keys.test.ts). The reader view applies it to presses from two
// places: its own Obsidian Scope, which sees keys in the host document, and
// the engine, which forwards presses from inside an EPUB's section iframes —
// key events do not cross an iframe boundary, so the Scope never sees those.

export type KeyAction = "next" | "prev" | "dismiss";

/** The parts of a KeyboardEvent the mapping reads. */
export interface KeyPress {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Left/Right and PageUp/PageDown turn the page; Escape dismisses. Up/Down and
 * Space are left to the platform, since in a scrolled book they already
 * scroll. Any modifier means the press belongs to something else — Shift
 * extends a selection, and the rest are hotkeys.
 */
export function keyAction(press: KeyPress): KeyAction | null {
  if (press.altKey || press.ctrlKey || press.metaKey) return null;
  if (press.key === "Escape") return "dismiss";
  if (press.shiftKey) return null;
  switch (press.key) {
    case "ArrowRight":
    case "PageDown":
      return "next";
    case "ArrowLeft":
    case "PageUp":
      return "prev";
    default:
      return null;
  }
}

/** Whether a press is going into something the reader is typing in, like the page box. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false;
  const el = target as HTMLElement;
  return el.isContentEditable || el.closest("input, textarea, select, [contenteditable='true']") !== null;
}
