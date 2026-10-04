// What a swipe or a scroll means for the reader, kept apart from the DOM so
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

/** How far the page has to move one way before the toolbar follows. */
const SCROLL_CHROME_PX = 24;
/** Within this much of the top, the toolbar always shows. */
const SCROLL_TOP_PX = 8;

/**
 * Hides the toolbar as the reader scrolls down into the book and brings it
 * back as soon as they scroll up, the way a phone's browser does. Movement
 * is summed per direction, so the small back-and-forth of a resting finger
 * does neither, and a jump of more than a screen (a link, a search result, a
 * new chapter loading) is not scrolling at all and is ignored.
 */
export class ScrollChrome {
  private lastTop: number | null = null;
  private travel = 0;

  /** The scroll position changed; returns what the toolbar should do, if anything. */
  update(top: number, viewportHeight: number): "hide" | "show" | null {
    const last = this.lastTop;
    this.lastTop = top;
    if (top <= SCROLL_TOP_PX) {
      this.travel = 0;
      return "show";
    }
    if (last === null) return null;
    const delta = top - last;
    if (delta === 0) return null;
    if (Math.abs(delta) > viewportHeight) {
      this.travel = 0;
      return null;
    }
    if (this.travel !== 0 && Math.sign(this.travel) !== Math.sign(delta)) this.travel = 0;
    this.travel += delta;
    if (Math.abs(this.travel) < SCROLL_CHROME_PX) return null;
    const action = this.travel > 0 ? "hide" : "show";
    this.travel = 0;
    return action;
  }

  /** Forgets the last position, for a different scroller or a new book. */
  reset(): void {
    this.lastTop = null;
    this.travel = 0;
  }
}
