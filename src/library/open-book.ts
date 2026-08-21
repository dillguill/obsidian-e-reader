// Pure decision of where a book should open, given the modifier state of
// the mouse/keyboard event that triggered the open — matching Obsidian's
// own link-opening conventions (plain -> same tab, Ctrl/Cmd -> new tab,
// Ctrl/Cmd+Alt -> split, middle click -> new tab) so a library card behaves
// the way every other link in the vault does. The actual `openLinkText`
// call site lives in library-view.ts; this module only decides the target.

export type OpenTarget = "same-tab" | "new-tab" | "split";

export interface OpenBookModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** Mouse button index (0 = primary, 1 = middle, 2 = secondary). Absent for keyboard activation. */
  button?: number;
}

const MIDDLE_CLICK = 1;

export function decideOpenTarget(modifiers: OpenBookModifiers): OpenTarget {
  if (modifiers.button === MIDDLE_CLICK) return "new-tab";
  const primaryModifier = modifiers.ctrlKey || modifiers.metaKey;
  if (!primaryModifier) return "same-tab";
  return modifiers.altKey ? "split" : "new-tab";
}
