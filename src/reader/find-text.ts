// Finding a query inside a page's text.
//
// Both sides of a find work on text whose whitespace has already been
// collapsed (src/reader/text-index.ts): the scan reads it from the worker,
// the painting reads it back off the rendered spans. Normalising the query
// the same way is what lets a phrase typed across a line break match a phrase
// the PDF broke across two text items.
//
// Pure — no DOM, no pdf.js — so the edge cases are unit tested directly
// (tests/unit/find-text.test.ts).

import { normalizeQuote } from "../annotations/anchor";
import type { FindQuery } from "./engine";

/**
 * Where each match of `query` starts in `text`, in order. Matches do not
 * overlap: the search resumes past the end of the one it just found, so
 * "aa" occurs twice in "aaaa" rather than three times.
 */
export function matchOffsets(text: string, query: FindQuery): number[] {
  const needle = normalizeQuote(query.query);
  if (needle === "" || text === "") return [];

  const haystack = query.caseSensitive ? text : text.toLowerCase();
  const target = query.caseSensitive ? needle : needle.toLowerCase();

  const found: number[] = [];
  let from = 0;
  while (true) {
    const at = haystack.indexOf(target, from);
    if (at === -1) return found;
    found.push(at);
    from = at + target.length;
  }
}

export function countMatches(text: string, query: FindQuery): number {
  return matchOffsets(text, query).length;
}

/**
 * Which match, as the page it is on and its position among that page's
 * matches. A find is tracked this way rather than by a single number counted
 * from the start of the book, because the scan begins at the page being read
 * and wraps: pages earlier in the book have not been counted yet, so a global
 * number would silently come to mean a different match as the scan filled
 * them in behind it.
 */
export interface MatchAt {
  page: number;
  nth: number;
}

/** Matches found so far. Pages the scan has not reached hold none. */
export function totalMatches(counts: readonly number[]): number {
  let total = 0;
  for (const count of counts) total += count ?? 0;
  return total;
}

/** How many matches come before this one, which is what the find bar counts. */
export function matchIndex(counts: readonly number[], at: MatchAt): number {
  let before = 0;
  for (let page = 1; page < at.page; page++) before += counts[page - 1] ?? 0;
  return before + at.nth;
}

/**
 * The first match on `fromPage` or after it, wrapping round to the start of
 * the book rather than giving up at the end.
 */
export function firstMatch(counts: readonly number[], fromPage: number): MatchAt | null {
  const pages = counts.length;
  if (pages === 0) return null;
  const start = Math.min(Math.max(1, fromPage), pages);
  for (let step = 0; step < pages; step++) {
    const page = ((start - 1 + step) % pages) + 1;
    if ((counts[page - 1] ?? 0) > 0) return { page, nth: 0 };
  }
  return null;
}

/** The match after `at`, or before it, wrapping at either end of the book. */
export function stepMatch(counts: readonly number[], at: MatchAt, backwards: boolean): MatchAt | null {
  const pages = counts.length;
  if (pages === 0 || totalMatches(counts) === 0) return null;

  if (!backwards) {
    if (at.nth + 1 < (counts[at.page - 1] ?? 0)) return { page: at.page, nth: at.nth + 1 };
    for (let step = 1; step <= pages; step++) {
      const page = ((at.page - 1 + step) % pages) + 1;
      if ((counts[page - 1] ?? 0) > 0) return { page, nth: 0 };
    }
    return null;
  }

  if (at.nth > 0) return { page: at.page, nth: at.nth - 1 };
  for (let step = 1; step <= pages; step++) {
    const page = ((at.page - 1 - step + pages * 2) % pages) + 1;
    const count = counts[page - 1] ?? 0;
    if (count > 0) return { page, nth: count - 1 };
  }
  return null;
}
