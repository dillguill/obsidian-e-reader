// Pure progress-percentage math shared by both reader adapters. Kept free of
// any engine/DOM dependency so it can be unit tested directly.

/** Clamps to the 0–100 range and guards against NaN/Infinity from engine math. */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Converts an EPUB engine's 0–1 fraction-through-book into a 0–100 percent. */
export function fractionToPercent(fraction: number): number {
  return clampProgress(Math.round(fraction * 100));
}

/** Converts a 1-based PDF page number into a 0–100 percent through the document. */
export function pdfPageToPercent(page: number, totalPages: number): number {
  if (totalPages <= 0) return 0;
  return clampProgress(Math.round((page / totalPages) * 100));
}
