// Turning a DOM Range into the text-quote anchor an entry stores.
//
// Shared by both adapters: an EPUB selection lives inside epub.js's iframe
// document, a PDF selection inside pdf.js's text layer, but both hand us a
// Range over a subtree whose text we can walk.

import { contextAround, normalizeQuote } from "../annotations/anchor";

export interface SelectionSnapshot {
  /** The selected text, whitespace-normalised (anchor.ts, normalizeQuote). */
  exact: string;
  prefix: string;
  suffix: string;
}

/**
 * The character offset of (`node`, `offset`) within `root`'s text content,
 * counting only text nodes in document order. Returns null when `node` is
 * not inside `root` — a selection that started in another document.
 */
function offsetWithin(root: Node, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT) ?? null;
  if (walker === null) return null;
  let total = 0;
  let current = walker.nextNode();
  while (current !== null) {
    if (current === node) return total + offset;
    total += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  // A range endpoint can sit on an element rather than a text node; treating
  // it as "everything walked so far" is the closest honest answer.
  return total;
}

export function snapshotFromRange(root: HTMLElement, range: Range): SelectionSnapshot | null {
  const exact = normalizeQuote(range.toString());
  if (exact === "") return null;

  const text = root.textContent ?? "";
  const start = offsetWithin(root, range.startContainer, range.startOffset);
  const end = offsetWithin(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return { exact, prefix: "", suffix: "" };

  const context = contextAround(text, start, end);
  return { exact, prefix: normalizeQuote(context.prefix), suffix: normalizeQuote(context.suffix) };
}

/** The first non-collapsed range in `selection`, or null. */
export function activeRange(selection: Selection | null): Range | null {
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return range.collapsed ? null : range;
}
