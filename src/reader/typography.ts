// Line spacing and margins for reflowable books.
//
// Kept apart from the EPUB adapter so the choices, their labels and the CSS
// each one produces can be tested without epub.js or a DOM
// (tests/unit/typography.test.ts).
//
// Both default to "normal", which is exactly what the reader did before the
// options existed: the line height comes from the theme and is set on `body`
// only, so a book's own spacing still wins, and the text runs the full width
// of the pane.

export type LineSpacing = "compact" | "normal" | "relaxed";
export type Margins = "normal" | "wide" | "extra-wide";

export const LINE_SPACINGS: readonly LineSpacing[] = ["compact", "normal", "relaxed"];
export const MARGINS: readonly Margins[] = ["normal", "wide", "extra-wide"];

export function isLineSpacing(value: unknown): value is LineSpacing {
  return typeof value === "string" && (LINE_SPACINGS as readonly string[]).includes(value);
}

export function isMargins(value: unknown): value is Margins {
  return typeof value === "string" && (MARGINS as readonly string[]).includes(value);
}

export const LINE_SPACING_LABELS: Record<LineSpacing, string> = {
  compact: "Compact",
  normal: "Normal",
  relaxed: "Relaxed",
};

export const MARGIN_LABELS: Record<Margins, string> = {
  normal: "Normal",
  wide: "Wide",
  "extra-wide": "Extra wide",
};

/** The forced line height for a choice, or null for "leave it to the book". */
export function lineHeightFor(spacing: LineSpacing): number | null {
  switch (spacing) {
    case "compact":
      return 1.3;
    case "relaxed":
      return 1.8;
    default:
      return null;
  }
}

/**
 * CSS for the section's own document. A forced line height has to reach the
 * block elements themselves, because books routinely set one on `p` and a
 * value on `body` alone would change nothing.
 */
export function lineSpacingCss(spacing: LineSpacing): string {
  const height = lineHeightFor(spacing);
  if (height === null) return "";
  return `body, p, li, blockquote, dd, dt, div { line-height: ${height} !important; }`;
}

/**
 * The inline padding put around the book, applied to the host element epub.js
 * renders into rather than inside the section. Paginated flow sets the
 * section body's padding itself, with `!important`, to lay out its columns,
 * so the only margin that works in both flows is one outside the iframe.
 * Clamped so a phone keeps most of its width and a wide pane gets a readable
 * measure.
 */
export function marginPadding(margins: Margins): string {
  switch (margins) {
    case "wide":
      return "clamp(16px, 8%, 120px)";
    case "extra-wide":
      return "clamp(32px, 18%, 280px)";
    default:
      return "";
  }
}
