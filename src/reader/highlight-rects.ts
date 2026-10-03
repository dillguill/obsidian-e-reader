// Turning a highlighted Range's client rects into boxes that read as one
// highlight.
//
// `getClientRects()` returns a box per inline fragment. In a PDF text layer
// that is one per pdf.js span, and each span's box is as tall as the font's
// ascent plus descent, which is usually taller than the gap between lines.
// Drawn as-is, neighbouring boxes overlap, and because the boxes multiply
// onto the page, every overlap shows up as a darker band. This merges the
// fragments of a line into one box and splits any overlap between lines at
// its midpoint, so no part of the page is painted twice.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Two boxes are on the same line when they share most of their height. */
function sameLine(a: Box, b: Box): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlap > 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top);
}

function overlapsHorizontally(a: Box, b: Box): boolean {
  return Math.min(a.right, b.right) > Math.max(a.left, b.left);
}

export function mergeHighlightBoxes(rects: readonly Box[]): Box[] {
  const lines: Box[] = [];
  const sorted = rects
    .filter((rect) => rect.right > rect.left && rect.bottom > rect.top)
    .sort((a, b) => a.top - b.top || a.left - b.left);

  for (const rect of sorted) {
    // Only a line that reaches this fragment horizontally (or nearly) can
    // absorb it, so two columns at the same height stay separate boxes.
    const line = lines.find(
      (candidate) => sameLine(candidate, rect) && rect.left <= candidate.right + (rect.bottom - rect.top) && rect.right >= candidate.left - (rect.bottom - rect.top),
    );
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      // Copied field by field: a DOMRect's sides are prototype getters, so
      // spreading one yields an empty object.
      lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }

  lines.sort((a, b) => a.top - b.top || a.left - b.left);
  for (let i = 0; i < lines.length; i++) {
    const upper = lines[i] as Box;
    for (let j = i + 1; j < lines.length; j++) {
      const lower = lines[j] as Box;
      if (lower.top >= upper.bottom) break;
      if (!overlapsHorizontally(upper, lower)) continue;
      const middle = (upper.bottom + lower.top) / 2;
      upper.bottom = middle;
      lower.top = middle;
    }
  }
  return lines.filter((line) => line.bottom > line.top);
}
