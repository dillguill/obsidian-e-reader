// Zoom / text-size arithmetic, shared by both adapters and the toolbar.
//
// One multiplier means two things depending on the format, and deliberately
// so: for a fixed-page PDF it is the render scale handed to pdf.js's
// getViewport, for a reflowable EPUB it is the percentage handed to epub.js's
// themes.fontSize. Stepping, clamping and the fit calculation are identical
// either way, so they live here rather than twice in the adapters.
//
// Pure — no DOM, no engine — so the stepping edge cases are unit tested
// directly (tests/unit/zoom.test.ts).

/** The scales the ± buttons walk through. Ascending, and 1 is "actual size". */
export const SCALE_STEPS: readonly number[] = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export const MIN_SCALE = SCALE_STEPS[0] as number;
export const MAX_SCALE = SCALE_STEPS[SCALE_STEPS.length - 1] as number;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The next step above (`direction` 1) or below (-1) `current`. A scale that
 * sits between two steps — anything reached through a fit mode — snaps to the
 * next step in the direction of travel rather than jumping past it.
 */
export function stepScale(current: number, direction: 1 | -1): number {
  const from = Number.isFinite(current) ? current : 1;
  // A hair of tolerance so that a scale that IS a step (modulo float noise)
  // moves off it rather than snapping back onto itself.
  const epsilon = 1e-6;
  if (direction === 1) {
    for (const step of SCALE_STEPS) {
      if (step > from + epsilon) return step;
    }
    return MAX_SCALE;
  }
  for (let i = SCALE_STEPS.length - 1; i >= 0; i--) {
    const step = SCALE_STEPS[i] as number;
    if (step < from - epsilon) return step;
  }
  return MIN_SCALE;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The scale at which a page of `page` size (measured at scale 1) fills
 * `available`: along one axis for "width"/"height", or entirely within both
 * for "page" — which is pdf.js's own `page-fit`, the smaller of the two
 * (pdf_viewer.mjs: `scale = Math.min(pageWidthScale, pageHeightScale)`).
 *
 * Returns 1 — not 0 or Infinity — when either size is unusable, which
 * happens whenever this is called before the container has been laid out.
 */
export function fitScale(available: Size, page: Size, mode: "width" | "height" | "page"): number {
  if (mode === "page") {
    const byWidth = fitScale(available, page, "width");
    const byHeight = fitScale(available, page, "height");
    return Math.min(byWidth, byHeight);
  }
  const availableExtent = mode === "width" ? available.width : available.height;
  const pageExtent = mode === "width" ? page.width : page.height;
  if (!(availableExtent > 0) || !(pageExtent > 0)) return 1;
  return clampScale(availableExtent / pageExtent);
}

/**
 * The size a whole rendered row occupies at scale 1, which is what a fit mode
 * actually has to fit. In a spread mode that is two pages plus the gap
 * between them — fitting a single page there would render the row at twice
 * the width of the pane.
 */
export function fitRowSize(page: Size, pagesPerRow: number, gap: number): Size {
  const count = Math.max(1, Math.floor(pagesPerRow));
  const usableGap = Number.isFinite(gap) ? gap : 0;
  return {
    width: page.width * count + usableGap * (count - 1),
    height: page.height,
  };
}
