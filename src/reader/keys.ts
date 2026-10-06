// What a key press means to the reader.
//
// Kept as a pure mapping so it can be tested without a DOM
// (tests/unit/keys.test.ts). The reader view applies it to presses from two
// places: its own Obsidian Scope, which sees keys in the host document, and
// the engine, which forwards presses from inside an EPUB's section iframes —
// key events do not cross an iframe boundary, so the Scope never sees those.

export type KeyAction = "next" | "prev" | "advance" | "retreat" | "next-chapter" | "prev-chapter" | "dismiss" | "search";

/** The parts of a KeyboardEvent the mapping reads. */
export interface KeyPress {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Left/Right and PageUp/PageDown turn the page; Shift-Left/Right go to the
 * previous or next chapter; Escape dismisses; Cmd/Ctrl-F searches the book.
 * Space and Shift-Space are "advance" and "retreat": a page in a book that
 * has pages, which the view decides, since in a scrolled PDF the platform's
 * own screenful is the better step. Up/Down are left to the platform. Any
 * other modifier means the press belongs to something else; the view also
 * leaves Shift-arrows alone while there is a selection for them to extend.
 */
export function keyAction(press: KeyPress): KeyAction | null {
  // Cmd-F on a Mac, Ctrl-F elsewhere: searching the book rather than the app.
  if ((press.ctrlKey || press.metaKey) && !press.altKey && !press.shiftKey && press.key.toLowerCase() === "f") {
    return "search";
  }
  if (press.altKey || press.ctrlKey || press.metaKey) return null;
  if (press.key === "Escape") return "dismiss";
  if (press.key === " ") return press.shiftKey ? "retreat" : "advance";
  if (press.shiftKey) {
    if (press.key === "ArrowRight") return "next-chapter";
    if (press.key === "ArrowLeft") return "prev-chapter";
    return null;
  }
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
