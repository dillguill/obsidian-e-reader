// What a swipe means for the reader, kept apart from the DOM so
// it can be tested (tests/unit/gestures.test.ts).

/** A swipe has to travel this far sideways to turn the page. */
const SWIPE_MIN_PX = 50;
/** ...and mostly sideways: this many times further across than down. */
const SWIPE_RATIO = 1.5;
/** A slow drag is the reader reading or selecting, not swiping. */
const SWIPE_MAX_MS = 700;

/**
 * The page a horizontal swipe asks for: right to left is the next page, the
 * way a page is turned. `dx` and `dy` are the finger's travel.
 */
export function swipeDirection(dx: number, dy: number, ms: number): "next" | "prev" | null {
  if (ms > SWIPE_MAX_MS || Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return null;
  return dx < 0 ? "next" : "prev";
}

/**
 * A swipe up or down in a paginated book (down: the finger travelling down
 * the screen). The same thresholds as a sideways swipe, turned on their side.
 */
export function verticalSwipe(dx: number, dy: number, ms: number): "up" | "down" | null {
  if (ms > SWIPE_MAX_MS || Math.abs(dy) < SWIPE_MIN_PX || Math.abs(dy) < Math.abs(dx) * SWIPE_RATIO) return null;
  return dy > 0 ? "down" : "up";
}
