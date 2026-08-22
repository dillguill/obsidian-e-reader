import { describe, expect, it } from "vitest";
import { isBookNote } from "../../src/core/book-note";

const MARKER = "type";
const VALUE = "book";

describe("isBookNote", () => {
  it("accepts a note carrying the marker", () => {
    expect(isBookNote({ type: "book" }, MARKER, VALUE)).toBe(true);
  });

  it("rejects a note without the marker at all", () => {
    expect(isBookNote({ title: "Notes" }, MARKER, VALUE)).toBe(false);
    expect(isBookNote({}, MARKER, VALUE)).toBe(false);
    expect(isBookNote(null, MARKER, VALUE)).toBe(false);
    expect(isBookNote(undefined, MARKER, VALUE)).toBe(false);
  });

  it("rejects a note marked as something else", () => {
    expect(isBookNote({ type: "article" }, MARKER, VALUE)).toBe(false);
    expect(isBookNote({ type: "" }, MARKER, VALUE)).toBe(false);
  });

  // A note can legitimately be several things at once.
  it("accepts a list that includes the marker value", () => {
    expect(isBookNote({ type: ["textbook", "book"] }, MARKER, VALUE)).toBe(true);
    expect(isBookNote({ type: ["article", "note"] }, MARKER, VALUE)).toBe(false);
  });

  it("ignores surrounding whitespace and case", () => {
    expect(isBookNote({ type: " Book " }, MARKER, VALUE)).toBe(true);
  });

  it("reads a non-string scalar by its text, so `type: 1` can be matched", () => {
    expect(isBookNote({ type: 1 }, MARKER, "1")).toBe(true);
  });

  // Clearing either setting is how a reader opts out of the check, rather
  // than being locked out of their own notes by a name they cannot match.
  it("treats a blank marker name as no requirement", () => {
    expect(isBookNote({ title: "Anything" }, "", VALUE)).toBe(true);
  });

  it("treats a blank marker value as `any value will do`", () => {
    expect(isBookNote({ type: "anything" }, MARKER, "")).toBe(true);
    expect(isBookNote({ type: "" }, MARKER, "")).toBe(false);
    expect(isBookNote({ title: "no marker" }, MARKER, "")).toBe(false);
  });
});
