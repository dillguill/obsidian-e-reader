// What the reader toolbar shows, derived from what the engine reports.
//
// The toolbar element itself (toolbar.ts) does nothing but apply this: every
// enable/disable rule and every piece of label text is decided here, where it
// can be unit tested without a DOM (tests/unit/toolbar-model.test.ts).
//
// A PDF's box holds a page number. An EPUB has no pages — its numbers are
// epub.js's generated locations, which mean nothing to a reader — so its box
// holds a percentage through the book instead, and a typed percentage is
// turned back into a location here.

import type { PageState } from "./engine";

function roundedPercent(progress: number): number {
  return Math.round(Math.min(100, Math.max(0, progress)));
}

/** `of 340` for pages, `%` for a reflowable book. Empty while the engine cannot yet say where it is. */
export function pageLabel(pages: PageState | null): string {
  if (pages === null) return "";
  return pages.unit === "location" ? "%" : `of ${pages.total}`;
}

/** What the box displays. Empty rather than `0` when there is no state. */
export function pageValue(pages: PageState | null, progress: number): string {
  if (pages === null) return "";
  return pages.unit === "location" ? String(roundedPercent(Number.isFinite(progress) ? progress : 0)) : String(pages.current);
}

/**
 * A typed number, clamped into `min`–`max`. Null when the entry is not a
 * number at all — the caller restores the box's previous value rather than
 * navigating anywhere.
 */
export function clampPageInput(raw: string, max: number, min = 1): number | null {
  if (!(max > 0)) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** The page or location a value typed into the box means. */
export function targetFromInput(value: number, pages: PageState): number {
  if (pages.unit !== "location") return value;
  const fraction = Math.min(100, Math.max(0, value)) / 100;
  return Math.min(pages.total, Math.max(1, Math.round(fraction * (pages.total - 1)) + 1));
}

/**
 * `42%`. Empty until the engine can place the reader in the whole book, since
 * an EPUB reports 0 until its location index is built and a 0% that jumps to
 * 37% a few seconds later reads as a bug.
 */
export function progressLabel(pages: PageState | null, progress: number): string {
  if (pages === null || !Number.isFinite(progress)) return "";
  return `${roundedPercent(progress)}%`;
}

export interface ToolbarInputs {
  pages: PageState | null;
  bookmarked: boolean;
  /** 0–100 through the whole book. */
  progress: number;
}

export interface ToolbarState {
  pageEnabled: boolean;
  pageValue: string;
  pageLabel: string;
  /** Bounds a typed entry: the page count, or 100 for a percentage. 0 while unknown. */
  pageMax: number;
  pageMin: number;
  /** What the box holds, for its accessible name. */
  pageName: "Page" | "Percent";
  bookmarked: boolean;
  /**
   * Whether the page buttons can move. Only the ends of a known page range
   * disable them: a book that cannot yet say where it is still turns.
   */
  canGoBack: boolean;
  canGoForward: boolean;
}

export function toolbarState(inputs: ToolbarInputs): ToolbarState {
  const pages = inputs.pages;
  const percent = pages?.unit === "location";
  return {
    pageEnabled: pages !== null,
    pageValue: pageValue(pages, inputs.progress),
    pageLabel: pageLabel(pages),
    pageMax: pages === null ? 0 : percent ? 100 : pages.total,
    pageMin: percent ? 0 : 1,
    pageName: percent ? "Percent" : "Page",
    bookmarked: inputs.bookmarked,
    canGoBack: pages === null || pages.current > 1,
    canGoForward: pages === null || pages.current < pages.total,
  };
}
