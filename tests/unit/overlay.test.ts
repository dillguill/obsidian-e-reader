import { describe, it, expect } from "vitest";
import { decideReadStateOverlay, decideProgressOverlay } from "../../src/library/overlay";
import type { BasesPropertyId } from "obsidian";

const READ_STATE_PROP = "note.read-state" as BasesPropertyId;
const PROGRESS_PROP = "note.progress" as BasesPropertyId;

describe("decideReadStateOverlay", () => {
  it("renders nothing when the property is unbound", () => {
    expect(decideReadStateOverlay(null, "reading")).toEqual({ kind: "none" });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace-only string", "   "],
  ])("renders nothing for %s", (_label, raw) => {
    expect(decideReadStateOverlay(READ_STATE_PROP, raw)).toEqual({ kind: "none" });
  });

  it("renders nothing for an unrecognised wrapper object (stand-in for ErrorValue)", () => {
    // Obsidian's ErrorValue class is referenced in the BasesEntry.getValue doc
    // comment but is not exported from the public obsidian.d.ts (verified
    // against 1.13.1) so it cannot be imported/instanceof-checked here. Any
    // non-scalar wrapper — including a real ErrorValue — must be treated as
    // "no data", never guessed at.
    const errorLike = { toString: () => "reading" };
    expect(decideReadStateOverlay(READ_STATE_PROP, errorLike)).toEqual({ kind: "none" });
  });

  it.each(["unread", "reading", "finished"] as const)("maps a recognised read state %s", (state) => {
    expect(decideReadStateOverlay(READ_STATE_PROP, state)).toEqual({ kind: "read-state", state });
  });

  it("never guesses at an unrecognised read-state string", () => {
    expect(decideReadStateOverlay(READ_STATE_PROP, "in-progress")).toEqual({ kind: "none" });
  });

  it("is case-sensitive: never guesses at a differently-cased match", () => {
    expect(decideReadStateOverlay(READ_STATE_PROP, "Reading")).toEqual({ kind: "none" });
  });

  it("never infers read state from a progress-shaped numeric value", () => {
    expect(decideReadStateOverlay(READ_STATE_PROP, 75)).toEqual({ kind: "none" });
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
