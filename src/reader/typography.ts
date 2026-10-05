// How a reflowable book is set: font, line spacing, margins, justification
// and hyphenation, plus the reading theme both formats share.
//
// Kept apart from the EPUB adapter so the choices, their labels and the CSS
// each one produces can be tested without epub.js or a DOM
// (tests/unit/typography.test.ts).
//
// Every default is exactly what the reader did before the option existed:
// the line height and font come from the theme and are set on `body` only,
// so a book's own styles still win, and the text runs the full width of the
// pane.

export type LineSpacing = "compact" | "normal" | "relaxed";
export type Margins = "normal" | "wide" | "extra-wide";
export type BookFont = "book" | "obsidian" | "serif" | "sans";
/** "auto" follows the vault's theme; the rest are fixed palettes. */
export type ReadingTheme = "auto" | "light" | "sepia" | "dark";

export interface Typography {
  font: BookFont;
  lineSpacing: LineSpacing;
  margins: Margins;
  align: TextAlign;
  hyphenate: boolean;
}

export const LINE_SPACINGS: readonly LineSpacing[] = ["compact", "normal", "relaxed"];
export const MARGINS: readonly Margins[] = ["normal", "wide", "extra-wide"];
export const BOOK_FONTS: readonly BookFont[] = ["book", "obsidian", "serif", "sans"];
export const READING_THEMES: readonly ReadingTheme[] = ["auto", "light", "sepia", "dark"];

function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
}

export const isLineSpacing = oneOf(LINE_SPACINGS);
export const isMargins = oneOf(MARGINS);
export const isBookFont = oneOf(BOOK_FONTS);
export const isReadingTheme = oneOf(READING_THEMES);

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

export const FONT_LABELS: Record<BookFont, string> = {
  book: "Book",
  obsidian: "Obsidian",
  serif: "Serif",
  sans: "Sans",
};

export const THEME_LABELS: Record<ReadingTheme, string> = {
  auto: "Match Obsidian",
  light: "Light",
  sepia: "Sepia",
  dark: "Dark",
};

const SERIF_STACK = `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", serif`;
const SANS_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif`;

/** Everything a forced font may restyle: all of the text except code, which keeps its monospace. */
const TEXT_ELEMENTS = "body, body *:not(pre):not(code):not(kbd):not(samp):not(pre *):not(code *)";
/** The blocks of running prose that line spacing, justification and hyphenation apply to. */
export const PROSE_ELEMENTS = "p, li, blockquote, dd, dt";

/**
 * How running text is aligned: as the book sets it, left-aligned (only what
 * the book justifies; its centred and right-aligned lines stay), or all of
 * it justified.
 */
export type TextAlign = "book" | "left" | "justify";
export const TEXT_ALIGNS: readonly TextAlign[] = ["book", "left", "justify"];
export const TEXT_ALIGN_LABELS: Record<TextAlign, string> = { book: "Book", left: "Left", justify: "Justify" };

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
 * CSS for the section's own document. `vaultFont` is Obsidian's text font,
 * which the "book" choice still sets on `body` as a fallback for books that
 * name no font of their own — the behaviour before there was a choice.
 */
export function typographyCss(typography: Typography, vaultFont: string): string {
  const rules: string[] = [];
  switch (typography.font) {
    case "book":
      rules.push(`body { font-family: ${vaultFont}; }`);
      break;
    case "obsidian":
      rules.push(`${TEXT_ELEMENTS} { font-family: ${vaultFont} !important; }`);
      break;
    case "serif":
      rules.push(`${TEXT_ELEMENTS} { font-family: ${SERIF_STACK} !important; }`);
      break;
    case "sans":
      rules.push(`${TEXT_ELEMENTS} { font-family: ${SANS_STACK} !important; }`);
      break;
  }
  // A forced line height has to reach the blocks themselves, because books
  // routinely set one on `p` and a value on `body` alone would change nothing.
  // Line breaking from Omni Book Reader (github.com/pavelpeng7/omni-book-reader,
  // src/reader-style.ts): kerning, and paragraphs broken as a whole rather
  // than line by line, which evens out a justified line's spaces.
  rules.push(`body { text-rendering: optimizeLegibility; font-kerning: normal; }`);
  rules.push(`${PROSE_ELEMENTS} { text-wrap: pretty; orphans: 2; widows: 2; }`);
  const height = lineHeightFor(typography.lineSpacing);
  if (height !== null) rules.push(`body, div, ${PROSE_ELEMENTS} { line-height: ${height} !important; }`);
  if (typography.align === "justify") rules.push(`${PROSE_ELEMENTS} { text-align: justify !important; }`);
  if (typography.hyphenate) {
    rules.push(`${PROSE_ELEMENTS} { -webkit-hyphens: auto !important; hyphens: auto !important; }`);
  }
  return rules.join("\n");
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
