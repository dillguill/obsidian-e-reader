// Types for the vendored foliate-js search, which ships as plain JavaScript.
// Only the surface this plugin uses is declared.

export interface SearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

export interface SearchResult {
  /** A live Range over the document that was searched. */
  range: Range;
  excerpt: SearchExcerpt;
}

export interface SearchMatcherOptions {
  defaultLocale?: string;
  matchCase?: boolean;
  matchDiacritics?: boolean;
  matchWholeWords?: boolean;
  acceptNode?: (node: Node) => number;
}

export type TextWalker = unknown;

/**
 * Builds a generator that yields every match of `query` in a Document, in
 * document order, each with a live Range and a context excerpt.
 */
export function searchMatcher(
  textWalker: TextWalker,
  options: SearchMatcherOptions,
): (doc: Document, query: string) => Generator<SearchResult>;
