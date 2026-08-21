// Turning a DOM Range into the text-quote anchor an entry stores.
//
// Shared by both adapters: an EPUB selection lives inside epub.js's iframe
// document, a PDF selection inside pdf.js's text layer, but both hand us a
// Range over a subtree whose text we can walk.

import { contextAround, normalizeQuote, resolveInText } from "../annotations/anchor";
import { type TextIndex, buildTextIndex } from "./text-index";

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


// ------------------------------------------------------------------ painting
//
// The reverse of the above: given a saved quote, find the Range it occupies
// in a rendered subtree, so a highlight can be drawn over it. `offsetWithin`
// walks the DOM to produce an offset; these walk an offset back to the DOM.

/** A rendered subtree's text nodes, in document order, paired with their text. */
export interface DomTextChunk {
  text: string;
  node: Text;
}

export function chunksFromRoot(root: Node): DomTextChunk[] {
  const chunks: DomTextChunk[] = [];
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT) ?? null;
  if (walker === null) return chunks;
  let current = walker.nextNode();
  while (current !== null) {
    chunks.push({ text: current.textContent ?? "", node: current as Text });
    current = walker.nextNode();
  }
  return chunks;
}

export interface SearchableText {
  index: TextIndex;
  chunks: DomTextChunk[];
}

/** A subtree prepared once, then searched for many highlights. */
export function searchableText(root: Node): SearchableText {
  const chunks = chunksFromRoot(root);
  return { index: buildTextIndex(chunks), chunks };
}

/** Turns a pair of offsets into {@link TextIndex.text} back into a live Range. */
export function rangeFromOffsets(source: SearchableText, start: number, end: number): Range | null {
  const from = source.index.locate(start);
  const to = source.index.locate(end);
  if (from === null || to === null) return null;
  const startNode = source.chunks[from.chunk]?.node;
  const endNode = source.chunks[to.chunk]?.node;
  if (!startNode || !endNode) return null;
  const range = startNode.ownerDocument?.createRange();
  if (!range) return null;
  try {
    range.setStart(startNode, Math.min(from.offset, startNode.length));
    range.setEnd(endNode, Math.min(to.offset, endNode.length));
  } catch (error) {
    // Offsets are computed from a snapshot of the tree; a re-render between
    // building the index and using it invalidates them rather than throwing
    // anywhere useful.
    console.debug("[e-reader] stale offsets while placing a highlight", error);
    return null;
  }
  return range.collapsed ? null : range;
}

/**
 * The Range holding `exact` inside a prepared subtree, disambiguated by the
 * recorded context. Null when the quote is absent or still ambiguous — an
 * ambiguous anchor is unanchored (FR-024), never a guess at one candidate.
 */
export function rangeForQuote(
  source: SearchableText,
  exact: string,
  context?: { prefix?: string; suffix?: string },
): Range | null {
  const quote = normalizeQuote(exact);
  if (quote === "") return null;
  const at = resolveInText(source.index.text, quote, context);
  if (at === null) return null;
  return rangeFromOffsets(source, at, at + quote.length);
}
