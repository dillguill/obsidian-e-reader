// How a fixed-page document pairs its pages.
//
// Only the mode itself lives here now. Grouping pages into rows used to as
// well, because the PDF adapter laid pages out by hand; pdf.js's own viewer
// does that, so the arithmetic went with it.

/** `odd` puts the cover alone and then pairs 2-3, 4-5; `even` pairs 1-2, 3-4. */
export type SpreadMode = "single" | "odd" | "even";

const SPREAD_MODES: readonly string[] = ["single", "odd", "even"];

/** Guards a value read back from `data.json`, which may be anything at all. */
export function isSpreadMode(value: unknown): value is SpreadMode {
  return typeof value === "string" && SPREAD_MODES.includes(value);
}
