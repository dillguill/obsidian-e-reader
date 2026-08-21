// What the reader toolbar shows, derived from what the engine reports.
//
// The toolbar element itself (toolbar.ts) does nothing but apply this: every
// enable/disable rule and every piece of label text is decided here, where it
// can be unit tested without a DOM (tests/unit/toolbar-model.test.ts).

import type { PageState } from "./engine";
import { MAX_SCALE, MIN_SCALE } from "./zoom";

/** `of 340`. Empty while the engine cannot yet say where it is. */
export function pageLabel(pages: PageState | null): string {
  return pages === null ? "" : `of ${pages.total}`;
}

/** What the page box displays. Empty rather than `0` when there is no state. */
export function pageValue(pages: PageState | null): string {
  return pages === null ? "" : String(pages.current);
}

/**
 * A typed page number, clamped into the document. Null when the entry is not
 * a number at all — the caller restores the box's previous value rather than
 * navigating anywhere.
 */
export function clampPageInput(raw: string, total: number): number | null {
  if (!(total > 0)) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(total, Math.max(1, Math.round(parsed)));
}

export interface ToolbarInputs {
  pages: PageState | null;
  scale: number;
  highlightsShown: boolean;
  bookmarked: boolean;
}

export interface ToolbarState {
  canZoomIn: boolean;
  canZoomOut: boolean;
  pageEnabled: boolean;
  pageValue: string;
  pageLabel: string;
  /** Bounds a typed entry. 0 when the engine cannot yet say how long the book is. */
  pageTotal: number;
  highlightsShown: boolean;
  bookmarked: boolean;
}

export function toolbarState(inputs: ToolbarInputs): ToolbarState {
  const scale = Number.isFinite(inputs.scale) ? inputs.scale : 1;
  return {
    canZoomIn: scale < MAX_SCALE,
    canZoomOut: scale > MIN_SCALE,
    pageEnabled: inputs.pages !== null,
    pageValue: pageValue(inputs.pages),
    pageLabel: pageLabel(inputs.pages),
    pageTotal: inputs.pages?.total ?? 0,
    highlightsShown: inputs.highlightsShown,
    bookmarked: inputs.bookmarked,
  };
}
