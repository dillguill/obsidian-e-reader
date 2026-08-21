// Grouping a fixed-page document's pages into rendered rows.
//
// A spread mode is nothing more than a decision about which page numbers
// share a row, so it is expressed here as pure arithmetic and the PDF adapter
// simply builds one element per row. Keeping it out of the adapter is what
// makes the awkward cases — a cover that stands alone, a lone trailing page —
// testable without pdf.js (tests/unit/spread.test.ts).

/** `odd` puts the cover alone and then pairs 2-3, 4-5; `even` pairs 1-2, 3-4. */
export type SpreadMode = "single" | "odd" | "even";

const SPREAD_MODES: readonly string[] = ["single", "odd", "even"];

/** Guards a value read back from `data.json`, which may be anything at all. */
export function isSpreadMode(value: unknown): value is SpreadMode {
  return typeof value === "string" && SPREAD_MODES.includes(value);
}

/**
 * The 1-based page numbers of each row, in reading order. Every page appears
 * exactly once; a row holds one or two pages.
 */
export function spreadRows(totalPages: number, mode: SpreadMode): number[][] {
  const total = Math.floor(totalPages);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (mode === "single") return Array.from({ length: total }, (_, i) => [i + 1]);

  const rows: number[][] = [];
  let page = 1;
  // Odd-first mode shows the cover on its own, the way a physical book opens.
  if (mode === "odd") {
    rows.push([1]);
    page = 2;
  }
  while (page <= total) {
    // The last page of an odd-length run has no partner and keeps its own row.
    rows.push(page + 1 <= total ? [page, page + 1] : [page]);
    page += 2;
  }
  return rows;
}
