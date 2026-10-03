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

export function snapshotFromRange(root: HTMLElement, range: Range): SelectionSnapshot | null {
  // Built from the same chunks the painter searches, not `range.toString()`:
  // that skips `<br>`, and pdf.js ends every text-layer line with one, so a
  // quote spanning two lines would come out with the words run together.
  const chunks = chunksFromRoot(root);
  let text = "";
  let start: number | null = null;
  let end: number | null = null;
  for (const chunk of chunks) {
    if (range.intersectsNode(chunk.node)) {
      const from = chunk.node === range.startContainer ? range.startOffset : 0;
      const to = chunk.node === range.endContainer ? range.endOffset : chunk.text.length;
      if (to > from) {
        if (start === null) start = text.length + from;
        end = text.length + to;
      }
    }
    text += chunk.text;
  }
  if (start === null || end === null) return null;

  const exact = normalizeQuote(text.slice(start, end));
  if (exact === "") return null;
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
// in a rendered subtree, so a highlight can be drawn over it. snapshotFromRange
// walks the DOM to produce an offset; these walk an offset back to the DOM.

/**
 * A rendered subtree's text, in document order: each text node with its own
 * text, and each `<br>` as a line break so the words either side of it stay
 * apart once whitespace is normalised.
 */
export interface DomTextChunk {
  text: string;
  node: Text | HTMLBRElement;
}

export function chunksFromRoot(root: Node): DomTextChunk[] {
  const chunks: DomTextChunk[] = [];
  const walker = root.ownerDocument?.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT) ?? null;
  if (walker === null) return chunks;
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === Node.TEXT_NODE) {
      chunks.push({ text: current.textContent ?? "", node: current as Text });
    } else if (current.nodeName === "BR") {
      chunks.push({ text: "\n", node: current as HTMLBRElement });
    }
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

function nodeLength(node: Text | HTMLBRElement): number {
  return node.nodeType === Node.TEXT_NODE ? (node as Text).length : 0;
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
    // A quote is trimmed, so its ends always fall in text nodes; a `<br>`
    // only ever supplies the whitespace between them.
    range.setStart(startNode, Math.min(from.offset, nodeLength(startNode)));
    range.setEnd(endNode, Math.min(to.offset, nodeLength(endNode)));
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
