// Pinch-to-zoom arithmetic, shared by both adapters.
//
// The gesture is applied when the fingers lift rather than continuously: a
// PDF page is a rasterised canvas and an EPUB section is a reflow, so neither
// can be re-rendered per frame. Live-scaling a CSS transform would preview it
// smoothly but would also drag the absolutely-positioned text layer out of
// alignment with the glyphs beneath, which is the one thing that must stay
// true for selection to work.
//
// Pure, so the degenerate gestures are covered without a touchscreen
// (tests/unit/pinch.test.ts).

import { clampScale } from "./zoom";

export interface Point {
  x: number;
  y: number;
}

/** How much the scale must change before a pinch counts as deliberate. */
export const PINCH_THRESHOLD = 0.05;

export function pinchDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The scale a pinch has reached, relative to where it started. A gesture that
 * began with the fingers touching has no width to divide by, and keeps the
 * starting scale rather than flying to a limit.
 */
export function pinchScale(startScale: number, startDistance: number, distance: number): number {
  if (!(startDistance > 0) || !(distance > 0)) return clampScale(startScale);
  return clampScale(startScale * (distance / startDistance));
}

/** Filters out the drift of two fingers resting on the screen. */
export function isPinchWorthApplying(from: number, to: number): boolean {
  return Math.abs(to - from) > PINCH_THRESHOLD;
}
