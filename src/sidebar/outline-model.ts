// The outline pane's display model.
//
// Two sources feed one list of rows: the book file's own table of contents
// (FR-025), and — only when the file declares none — the book note's
// markdown headings (FR-025a). Keeping the shaping pure means the nesting,
// the fallback and the current-section logic are all testable without a
// vault or a rendered book.

import { compareLocators } from "../core/locator";
import type { Locator } from "../core/types";
import type { OutlineNode } from "../reader/engine";

export type OutlineTarget = { kind: "book"; locator: Locator } | { kind: "note"; line: number };

export interface OutlineRow {
  label: string;
  /** 0 for a top-level entry; each level of nesting adds one. */
  depth: number;
  target: OutlineTarget;
}

/** Depth-first flattening of an engine's table of contents, preserving order. */
export function rowsFromOutline(nodes: OutlineNode[], depth = 0): OutlineRow[] {
  const rows: OutlineRow[] = [];
  for (const node of nodes) {
    const label = node.label.trim();
    rows.push({ label: label === "" ? "Untitled" : label, depth, target: { kind: "book", locator: node.locator } });
    rows.push(...rowsFromOutline(node.children, depth + 1));
  }
  return rows;
}

export interface NoteHeading {
  heading: string;
  /** Markdown heading level, 1–6. */
  level: number;
  line: number;
}

/**
 * The book note's own headings, used only when the file has no table of
 * contents. Depth is relative to the shallowest heading present, so a note
 * whose sections all start at `##` is not indented as if it were nested.
 */
export function rowsFromHeadings(headings: NoteHeading[]): OutlineRow[] {
  if (headings.length === 0) return [];
  const top = Math.min(...headings.map((heading) => heading.level));
  return headings.map((heading) => ({
    label: heading.heading.trim() === "" ? "Untitled" : heading.heading.trim(),
    depth: Math.max(0, heading.level - top),
    target: { kind: "note", line: heading.line },
  }));
}

/**
 * The row the reader is currently inside: the last one at or before
 * `current`. Returns -1 when nothing can be placed — an unknown position, an
 * empty outline, or a note-heading fallback, none of which carry locators
 * comparable to a reading position.
 */
export function activeRowIndex(rows: OutlineRow[], current: Locator | null): number {
  if (current === null) return -1;
  let active = -1;
  for (let i = 0; i < rows.length; i++) {
    const target = (rows[i] as OutlineRow).target;
    if (target.kind !== "book") continue;
    const order = compareLocators(target.locator, current);
    if (order === null) continue;
    if (order <= 0) active = i;
  }
  return active;
}
