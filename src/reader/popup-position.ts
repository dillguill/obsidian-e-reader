// Where the selection popup goes.
//
// Pure geometry, tested in tests/unit/popup-position.test.ts. Every box is in
// the same client coordinate space — the engines report the selection's rect
// in the top window's client space, iframe offsets already applied — and the
// result is relative to `bounds`, the element the popup is positioned in.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Space kept between the popup and the selection, and between it and the edges. */
export const POPUP_GAP = 8;

/**
 * Centres the popup over (or under) the selection, on the preferred side
 * when it fits there and the other side when it does not, and keeps it
 * inside `bounds` horizontally. Null when the selection has scrolled
 * entirely out of `bounds`: a popup pointing at nothing is worse than none.
 */
export function placePopup(
  anchor: Box,
  bounds: Box,
  size: Size,
  prefer: "above" | "below",
): { left: number; top: number } | null {
  if (anchor.bottom < bounds.top || anchor.top > bounds.bottom) return null;
  if (anchor.right < bounds.left || anchor.left > bounds.right) return null;

  const centre = (anchor.left + anchor.right) / 2;
  const minLeft = bounds.left + POPUP_GAP;
  const maxLeft = bounds.right - POPUP_GAP - size.width;
  const left = maxLeft < minLeft ? minLeft : Math.min(Math.max(centre - size.width / 2, minLeft), maxLeft);

  const above = anchor.top - POPUP_GAP - size.height;
  const below = anchor.bottom + POPUP_GAP;
  const fitsAbove = above >= bounds.top + POPUP_GAP;
  const fitsBelow = below + size.height <= bounds.bottom - POPUP_GAP;

  let top: number;
  if (prefer === "above") top = fitsAbove || !fitsBelow ? above : below;
  else top = fitsBelow || !fitsAbove ? below : above;
  // Neither side fits (a selection taller than the pane): pin it inside.
  top = Math.min(Math.max(top, bounds.top + POPUP_GAP), bounds.bottom - POPUP_GAP - size.height);

  return { left: left - bounds.left, top: top - bounds.top };
}
