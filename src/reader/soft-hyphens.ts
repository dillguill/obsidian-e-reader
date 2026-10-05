// Hyphenation the book carries itself. WebKit's own (`hyphens: auto`) does
// nothing in Obsidian's iOS app even with the language declared — measured
// on a phone, 0.4.0-beta.24 — so a justified line there can only break
// between whole words and spreads the rest into wide gaps. Soft hyphens
// (U+00AD) are break points every engine honours: invisible unless a line
// breaks there, when they show as a hyphen.
//
// They are written into the section's own text, so everything that reads the
// text back (highlight quotes, the text index the painter searches) skips
// them; see stripSoftHyphens and text-index.ts.

import { hyphenateSync } from "hyphen/en-us";

export const SOFT_HYPHEN = "­";
const SOFT_HYPHENS = /­/g;

/** Whether the bundled patterns cover a book in `lang` (a BCP 47 tag). */
export function canHyphenate(lang: string | null | undefined): boolean {
  return typeof lang === "string" && /^en\b/i.test(lang.trim());
}

/** `text` with a soft hyphen at every break point the English patterns allow. */
export function hyphenateText(text: string): string {
  return hyphenateSync(text, { html: false });
}

export function stripSoftHyphens(text: string): string {
  return text.replace(SOFT_HYPHENS, "");
}

/** Elements whose text is never hyphenated: code keeps its exact characters. */
const SKIP = new Set(["PRE", "CODE", "KBD", "SAMP", "SCRIPT", "STYLE", "TEXTAREA"]);
/** Marks a section document whose text carries soft hyphens. */
const MARK = "data-ereader-hyphenated";

/**
 * Adds soft hyphens to the running text of a section document, or takes
 * them out again. Idempotent either way, so it can run on every restyle.
 */
export function setSoftHyphens(doc: Document, on: boolean): void {
  const root = doc.documentElement;
  if (root.hasAttribute(MARK) === on || !doc.body) return;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (skipped(text)) continue;
    const next = on ? hyphenateText(text.data) : stripSoftHyphens(text.data);
    if (next !== text.data) text.data = next;
  }
  if (on) root.setAttribute(MARK, "");
  else root.removeAttribute(MARK);
}

function skipped(node: Text): boolean {
  for (let el = node.parentElement; el !== null; el = el.parentElement) {
    if (SKIP.has(el.tagName.toUpperCase())) return true;
  }
  return false;
}
