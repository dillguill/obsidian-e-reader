import { describe, it, expect } from "vitest";
import { decideReadStateOverlay, decideProgressOverlay } from "../../src/library/overlay";
import type { BasesPropertyId } from "obsidian";

const PROGRESS_PROP = "note.progress" as BasesPropertyId;

// The badge is now DERIVED from reading progress rather than read from a
// property of its own. `reading_status` is gone: it duplicated what progress
// already says, and nothing ever wrote it. The old rule that read state must
// never be inferred from progress existed to stop a separate, user-owned
// property being silently overwritten by a guess — with no such property left,
// the badge is simply a second rendering of the same number.
describe("decideReadStateOverlay", () => {
  it("renders nothing when the progress property is unbound", () => {
    expect(decideReadStateOverlay(null, 40)).toEqual({ kind: "none" });
  });

  it("renders nothing when the book has no progress recorded at all", () => {
    for (const raw of [null, undefined, "", "   ", {}, [], true]) {
      expect(decideReadStateOverlay(PROGRESS_PROP, raw)).toEqual({ kind: "none" });
    }
  });

  it("reads zero as unread", () => {
    expect(decideReadStateOverlay(PROGRESS_PROP, 0)).toEqual({ kind: "read-state", state: "unread" });
    expect(decideReadStateOverlay(PROGRESS_PROP, "0")).toEqual({ kind: "read-state", state: "unread" });
  });

  it("reads anything between the ends as reading", () => {
    for (const value of [1, 50, 99, "37"]) {
      expect(decideReadStateOverlay(PROGRESS_PROP, value)).toEqual({ kind: "read-state", state: "reading" });
    }
  });

  it("reads a hundred as finished", () => {
    expect(decideReadStateOverlay(PROGRESS_PROP, 100)).toEqual({ kind: "read-state", state: "finished" });
  });

  it("clamps out-of-range values rather than dropping the badge", () => {
    expect(decideReadStateOverlay(PROGRESS_PROP, 140)).toEqual({ kind: "read-state", state: "finished" });
    expect(decideReadStateOverlay(PROGRESS_PROP, -5)).toEqual({ kind: "read-state", state: "unread" });
  });

  it("renders nothing for a value that is not a number", () => {
    expect(decideReadStateOverlay(PROGRESS_PROP, "reading")).toEqual({ kind: "none" });
    expect(decideReadStateOverlay(PROGRESS_PROP, Number.NaN)).toEqual({ kind: "none" });
  });
});

describe("decideProgressOverlay", () => {
  it("renders nothing when the property is unbound", () => {
    expect(decideProgressOverlay(null, 50, "bar")).toEqual({ kind: "none" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["boolean", true],
  ])("renders nothing for %s", (_label, raw) => {
    expect(decideProgressOverlay(PROGRESS_PROP, raw, "bar")).toEqual({ kind: "none" });
  });

  it("renders nothing for an unrecognised wrapper object (stand-in for ErrorValue)", () => {
    const errorLike = { toString: () => "42" };
    expect(decideProgressOverlay(PROGRESS_PROP, errorLike, "bar")).toEqual({ kind: "none" });
  });

  it("renders nothing for a non-numeric string", () => {
    expect(decideProgressOverlay(PROGRESS_PROP, "not-a-number", "bar")).toEqual({ kind: "none" });
  });

  it("clamps a value above 100 down to 100", () => {
    expect(decideProgressOverlay(PROGRESS_PROP, 150, "bar")).toEqual({ kind: "progress", percent: 100, display: "bar" });
  });

  it("clamps a negative value up to 0", () => {
    expect(decideProgressOverlay(PROGRESS_PROP, -10, "percent")).toEqual({
      kind: "progress",
      percent: 0,
      display: "percent",
    });
  });

  it("passes an in-range value through unchanged", () => {
    expect(decideProgressOverlay(PROGRESS_PROP, 42, "bar")).toEqual({ kind: "progress", percent: 42, display: "bar" });
  });

  it("accepts a numeric string", () => {
    expect(decideProgressOverlay(PROGRESS_PROP, "77", "percent")).toEqual({
      kind: "progress",
      percent: 77,
      display: "percent",
    });
  });

  it("passes through the requested display mode", () => {
    expect(decideProgressOverlay(PROGRESS_PROP, 10, "percent")).toEqual({ kind: "progress", percent: 10, display: "percent" });
  });

  it("never infers progress from a read-state-shaped string value", () => {
    expect(decideProgressOverlay(PROGRESS_PROP, "reading", "bar")).toEqual({ kind: "none" });
  });
});
