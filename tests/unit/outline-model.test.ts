import { describe, expect, it } from "vitest";
import type { OutlineNode } from "../../src/reader/engine";
import {
  activeRowIndex,
  activeRowIndexForLine,
  filterRows,
  rowsFromHeadings,
  rowsFromOutline,
} from "../../src/sidebar/outline-model";

const page = (n: number): OutlineNode["locator"] => ({ kind: "pdf", page: n });

const toc: OutlineNode[] = [
  {
    label: "Part One",
    locator: page(1),
    children: [
      { label: "Chapter 1", locator: page(3), children: [] },
      { label: "Chapter 2", locator: page(20), children: [{ label: "A section", locator: page(24), children: [] }] },
    ],
  },
  { label: "Part Two", locator: page(40), children: [] },
];

describe("rowsFromOutline", () => {
  it("flattens depth-first, keeping reading order and nesting depth", () => {
    expect(rowsFromOutline(toc).map((row) => [row.label, row.depth])).toEqual([
      ["Part One", 0],
      ["Chapter 1", 1],
      ["Chapter 2", 1],
      ["A section", 2],
      ["Part Two", 0],
    ]);
  });

  it("is empty for a book that declares no contents", () => {
    expect(rowsFromOutline([])).toEqual([]);
  });

  it("labels an untitled entry rather than rendering a blank row", () => {
    expect(rowsFromOutline([{ label: "   ", locator: page(1), children: [] }])[0]?.label).toBe("Untitled");
  });
});

describe("rowsFromHeadings", () => {
  it("indents relative to the shallowest heading in the note", () => {
    const rows = rowsFromHeadings([
      { heading: "Notes", level: 2, line: 4 },
      { heading: "A thought", level: 3, line: 9 },
      { heading: "Highlights", level: 2, line: 20 },
    ]);
    expect(rows.map((row) => [row.label, row.depth])).toEqual([
      ["Notes", 0],
      ["A thought", 1],
      ["Highlights", 0],
    ]);
    expect(rows[1]?.target).toEqual({ kind: "note", line: 9 });
  });

  it("is empty for a note with no headings", () => {
    expect(rowsFromHeadings([])).toEqual([]);
  });
});

describe("activeRowIndex", () => {
  const rows = rowsFromOutline(toc);

  it("picks the last entry at or before the current position", () => {
    expect(activeRowIndex(rows, page(21))).toBe(2);
  });

  it("picks an entry that starts exactly at the current position", () => {
    expect(activeRowIndex(rows, page(40))).toBe(4);
  });

  it("reports nothing before the first entry", () => {
    expect(activeRowIndex(rows, { kind: "pdf", page: 0 })).toBe(-1);
  });

  it("reports nothing when the position is unknown", () => {
    expect(activeRowIndex(rows, null)).toBe(-1);
  });

  it("ignores note-heading rows, which carry no reading position", () => {
    const noteRows = rowsFromHeadings([{ heading: "Notes", level: 1, line: 0 }]);
    expect(activeRowIndex(noteRows, page(5))).toBe(-1);
  });
});

describe("activeRowIndexForLine", () => {
  const rows = rowsFromHeadings([
    { heading: "Intro", level: 1, line: 0 },
    { heading: "Body", level: 1, line: 10 },
    { heading: "Detail", level: 2, line: 14 },
  ]);

  it("picks the last heading at or before the cursor", () => {
    expect(activeRowIndexForLine(rows, 12)).toBe(1);
    expect(activeRowIndexForLine(rows, 14)).toBe(2);
  });

  it("reports nothing above the first heading, or with no cursor", () => {
    expect(activeRowIndexForLine(rowsFromHeadings([{ heading: "Body", level: 1, line: 5 }]), 2)).toBe(-1);
    expect(activeRowIndexForLine(rows, null)).toBe(-1);
  });
});

describe("filterRows", () => {
  const rows = rowsFromOutline(toc);

  it("keeps everything for an empty query", () => {
    expect(filterRows(rows, "  ")).toHaveLength(rows.length);
  });

  it("keeps a nested match together with its ancestors", () => {
    expect(filterRows(rows, "a section").map((row) => row.label)).toEqual(["Part One", "Chapter 2", "A section"]);
  });

  it("matches case-insensitively and keeps every hit", () => {
    expect(filterRows(rows, "part").map((row) => row.label)).toEqual(["Part One", "Part Two"]);
  });

  it("is empty when nothing matches", () => {
    expect(filterRows(rows, "zzz")).toEqual([]);
  });
});
