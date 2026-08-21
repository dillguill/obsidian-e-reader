// Text-quote anchoring. A highlight's authority is the quoted text itself
// (contracts/highlight-entry.md rule 3); the stored Locator is only a hint.
// These functions are pure so they can be unit tested without a vault, an
// epub.js Contents document, or a pdf.js text layer.

/**
 * Characters of context captured either side of a quote. Long enough to
 * disambiguate a phrase that repeats in ordinary prose, short enough that an
 * edit near the quote does not invalidate the anchor (contract, "Context
 * window"; resolves CHK011).
 */
export const CONTEXT_CHARS = 32;

export interface Context {
  prefix: string;
  suffix: string;
}

/**
 * The context either side of `text.slice(start, end)`. Out-of-range or
 * inverted ranges clamp rather than throw — callers are handing us offsets
 * from a live DOM selection, which can be stale by the time we read it.
 */
export function contextAround(text: string, start: number, end: number, window = CONTEXT_CHARS): Context {
  const from = Math.min(Math.max(0, start), text.length);
  const to = Math.min(Math.max(from, end), text.length);
  return {
    prefix: text.slice(Math.max(0, from - window), from),
    suffix: text.slice(to, Math.min(text.length, to + window)),
  };
}

/**
 * Collapses runs of whitespace to single spaces. A selection spanning a line
 * break in an EPUB or a column break in a PDF arrives with newlines that the
 * source text does not have in the same places, so both the stored quote and
 * anything matched against it are normalised the same way.
 */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function allIndexesOf(haystack: string, needle: string): number[] {
  if (needle === "") return [];
  const found: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/**
 * Where `exact` sits in `text`, disambiguated by the recorded context.
 * Returns the character offset, or null when the quote is absent or still
 * ambiguous after applying context — an ambiguous anchor is unanchored
 * (FR-024), never a guess at one of the candidates.
 */
export function resolveInText(text: string, exact: string, context?: Partial<Context>): number | null {
  const candidates = allIndexesOf(text, exact);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] as number;

  const prefix = context?.prefix ?? "";
  const suffix = context?.suffix ?? "";
  if (prefix === "" && suffix === "") return null;

  // Score by how much of the recorded context still agrees, so an edit that
  // shortened one side does not disqualify an otherwise unique match.
  let best: { at: number; score: number } | null = null;
  let tied = false;
  for (const at of candidates) {
    const beforeScore = commonSuffixLength(text.slice(Math.max(0, at - prefix.length), at), prefix);
    const afterScore = commonPrefixLength(text.slice(at + exact.length, at + exact.length + suffix.length), suffix);
    const score = beforeScore + afterScore;
    if (best === null || score > best.score) {
      best = { at, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  if (best === null || tied || best.score === 0) return null;
  return best.at;
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
