// Searching a book's text: finding the query, and shaping each match into a
// result the panel can list and the reader can jump to and mark.
//
// Both engines feed this the same thing — a whitespace-normalised string
// built by text-index.ts, from an EPUB section's document or a PDF page's
// text content — so matching, excerpts and the context that re-finds a match
// on the rendered page are decided once, here, and tested without a DOM
// (tests/unit/search.test.ts).

import { contextAround, normalizeQuote } from "../annotations/anchor";
import type { Locator } from "../core/types";

/** Results stop here: past this a query is too common for a list to help. */
export const MAX_SEARCH_RESULTS = 500;
/** Characters of the surrounding text shown either side of a match. */
const EXCERPT_CHARS = 48;

export interface TextMatch {
  start: number;
  end: number;
}

export interface SearchHit {
  locator: Locator;
  /** The matched text as the book has it, with the book's own capitalisation. */
  exact: string;
  /** Context that re-finds this match on the rendered page among others like it. */
  prefix: string;
  suffix: string;
  /** What the result list shows either side of the match. */
  before: string;
  after: string;
}

export interface SearchHandlers {
  /** Returns false once enough results have been collected, which stops the search. */
  hit(hit: SearchHit): boolean;
  /** 0–1 through the book. */
  progress(fraction: number): void;
}

/**
 * Every place `query` occurs in `text`, ignoring case and treating any run of
 * whitespace in the query as one space, the way `text` already is. Matches
 * do not overlap.
 */
export function findMatches(text: string, query: string): TextMatch[] {
  const needle = normalizeQuote(query);
  if (needle === "") return [];
  // Lower-casing is only safe to compare position-for-position when it does
  // not change a string's length, which a handful of characters (İ, ß in
  // some locales) do. Such text falls back to a case-sensitive search
  // rather than reporting offsets that point at the wrong words.
  const haystack = text.toLowerCase();
  const lowered = needle.toLowerCase();
  const caseless = haystack.length === text.length && lowered.length === needle.length;
  const source = caseless ? haystack : text;
  const target = caseless ? lowered : needle;

  const matches: TextMatch[] = [];
  let at = source.indexOf(target);
  while (at !== -1) {
    matches.push({ start: at, end: at + target.length });
    at = source.indexOf(target, at + target.length);
  }
  return matches;
}

/** Trims an excerpt edge back to a word boundary, so it never starts or ends mid-word. */
function trimToWord(text: string, side: "start" | "end"): string {
  if (side === "start") {
    const space = text.indexOf(" ");
    return space > 0 && space < text.length - 1 ? text.slice(space + 1) : text;
  }
  const space = text.lastIndexOf(" ");
  return space > 0 ? text.slice(0, space) : text;
}

export function hitFromText(text: string, match: TextMatch, locator: Locator): SearchHit {
  const context = contextAround(text, match.start, match.end);
  const beforeStart = Math.max(0, match.start - EXCERPT_CHARS);
  const afterEnd = Math.min(text.length, match.end + EXCERPT_CHARS);
  let before = text.slice(beforeStart, match.start);
  let after = text.slice(match.end, afterEnd);
  if (beforeStart > 0) before = `…${trimToWord(before, "start")}`;
  if (afterEnd < text.length) after = `${trimToWord(after, "end")}…`;
  return {
    locator,
    exact: text.slice(match.start, match.end),
    prefix: normalizeQuote(context.prefix),
    suffix: normalizeQuote(context.suffix),
    before,
    after,
  };
}

/** Lets the app paint between chunks of a long search. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
