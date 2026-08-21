// Serialise/parse Locators to and from the string form stored in note
// frontmatter and highlight `hint` fields (data-model.md, Locator). Malformed
// input is reported as `null`, never thrown — callers treat a Locator as
// untrusted vault content (R4: "a hint, not an authority").

import type { Locator } from "./types";

const PDF_RE = /^page=(\d+)(?:&offset=(\d+))?$/;
const EPUB_RE = /^epubcfi\(.+\)$/;

export function serializeLocator(locator: Locator): string {
  if (locator.kind === "epub") {
    return locator.cfi;
  }
  return locator.offset === undefined ? `page=${locator.page}` : `page=${locator.page}&offset=${locator.offset}`;
}

export function parseLocator(input: string): Locator | null {
  if (input === "") return null;

  if (EPUB_RE.test(input)) {
    return { kind: "epub", cfi: input };
  }

  const pdfMatch = input.match(PDF_RE);
  if (pdfMatch) {
    const page = Number(pdfMatch[1]);
    if (!Number.isInteger(page) || page < 1) return null;
    const offsetRaw = pdfMatch[2];
    if (offsetRaw === undefined) {
      return { kind: "pdf", page };
    }
    const offset = Number(offsetRaw);
    return { kind: "pdf", page, offset };
  }

  return null;
}

/**
 * Tokenises the numeric path of a CFI (`epubcfi(/6/4!/4/2/2[ch01]/2/1:0)`)
 * into an ordered list of integers, for lexicographic comparison. Bracketed
 * assertions (`[ch01]`) carry no ordering information and are dropped; the
 * trailing character offset (`:0`), if present, is appended as the final
 * token. Indirection steps (`!`) are treated as ordinary path separators —
 * within one book's CFIs they still walk the document in reading order.
 * Returns null if the path doesn't tokenise cleanly, so callers can fall
 * back to a defensible default instead of throwing.
 */
function tokeniseCfi(cfi: string): number[] | null {
  const inner = cfi.slice("epubcfi(".length, -1);
  const offsetMatch = inner.match(/:(\d+)$/);
  const withoutOffset = offsetMatch ? inner.slice(0, -offsetMatch[0].length) : inner;
  const withoutAssertions = withoutOffset.replace(/\[[^\]]*\]/g, "");

  const tokens: number[] = [];
  for (const segment of withoutAssertions.split("!")) {
    for (const part of segment.split("/")) {
      if (part === "") continue;
      const stepMatch = part.match(/^(\d+)/);
      if (!stepMatch) return null;
      tokens.push(Number(stepMatch[1]));
    }
  }
  if (offsetMatch) tokens.push(Number(offsetMatch[1]));
  return tokens;
}

function sign(n: number): -1 | 0 | 1 {
  if (n < 0) return -1;
  if (n > 0) return 1;
  return 0;
}

function compareCfi(a: string, b: string): -1 | 0 | 1 {
  const tokensA = tokeniseCfi(a);
  const tokensB = tokeniseCfi(b);
  if (tokensA === null || tokensB === null) {
    // Defensive fallback for a CFI that doesn't tokenise cleanly — never
    // throw, just fall back to a stable (if less meaningful) ordering.
    return sign(a < b ? -1 : a > b ? 1 : 0);
  }
  const len = Math.min(tokensA.length, tokensB.length);
  for (let i = 0; i < len; i++) {
    const diff = (tokensA[i] as number) - (tokensB[i] as number);
    if (diff !== 0) return sign(diff);
  }
  return sign(tokensA.length - tokensB.length);
}

function comparePdf(a: { page: number; offset?: number }, b: { page: number; offset?: number }): -1 | 0 | 1 {
  if (a.page !== b.page) return sign(a.page - b.page);
  const offsetA = a.offset ?? 0;
  const offsetB = b.offset ?? 0;
  return sign(offsetA - offsetB);
}

export function compareLocators(a: Locator, b: Locator): -1 | 0 | 1 | null {
  if (a.kind !== b.kind) return null;
  if (a.kind === "epub" && b.kind === "epub") return compareCfi(a.cfi, b.cfi);
  if (a.kind === "pdf" && b.kind === "pdf") return comparePdf(a, b);
  return null;
}
