// Pure logic deciding what read-state and progress overlays to render on a
// library card. No DOM; no runtime dependency on `obsidian` (BasesPropertyId
// is imported as a type only, so it is erased at compile time).
//
// Both overlays are decided from the SAME input: the reading-progress
// property. The badge used to read a `reading_status` property of its own,
// and the rule was that read state must never be inferred from progress —
// that rule protected a separate, user-owned property from being silently
// overwritten by a guess. That property is gone (it duplicated what progress
// already said, and nothing ever wrote it), so the badge is now openly a
// second rendering of the same number rather than a claim about a field of
// its own.
//
// A bound property's raw value, as handed to these functions, is expected
// to already be a plain scalar (string | number) once the caller has pulled
// it out of a Bases `Value`. Anything else — null, undefined, an empty
// string, or a non-scalar wrapper object — is treated as "no data" and
// never guessed at. This deliberately also covers Obsidian's `ErrorValue`:
// per the BasesEntry.getValue doc comment "errors come back as ErrorValue",
// but ErrorValue is not exported from the public obsidian.d.ts (verified
// against 1.13.1 — only referenced once, in that doc comment), so it cannot
// be imported or instanceof-checked here. Rejecting every non-scalar value
// covers it structurally without needing the class.

import type { BasesPropertyId } from "obsidian";
import type { ReadState } from "../core/types";

export type ProgressDisplay = "bar" | "percent";

export type ReadStateOverlay = { kind: "none" } | { kind: "read-state"; state: ReadState };

export type ProgressOverlay = { kind: "none" } | { kind: "progress"; percent: number; display: ProgressDisplay };

const NONE_OVERLAY = { kind: "none" } as const;

function isBoundProperty(propertyId: BasesPropertyId | null): propertyId is BasesPropertyId {
  return propertyId !== null;
}

/** True for a value shaped like what a real Bases `Value` becomes once stringified/numberised. */
function isUsableScalar(raw: unknown): raw is string | number {
  return typeof raw === "string" || typeof raw === "number";
}

/** The 0-100 reading progress in `raw`, or null when there is none to read. */
function readPercent(propertyId: BasesPropertyId | null, raw: unknown): number | null {
  if (!isBoundProperty(propertyId)) return null;
  if (!isUsableScalar(raw)) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(100, Math.max(0, numeric));
}

/**
 * The badge, derived from reading progress: nothing at 0, finished at 100,
 * reading in between. A book with no progress recorded has never been opened
 * — the reader writes progress the moment one is — and shows no badge at all,
 * so an untouched library is not covered in icons.
 *
 * Note that opening a long book and reading one page rounds to 0, and so
 * reads as unread until the second percent is reached.
 */
export function decideReadStateOverlay(propertyId: BasesPropertyId | null, raw: unknown): ReadStateOverlay {
  const percent = readPercent(propertyId, raw);
  if (percent === null) return NONE_OVERLAY;
  const state: ReadState = percent >= 100 ? "finished" : percent <= 0 ? "unread" : "reading";
  return { kind: "read-state", state };
}

export function decideProgressOverlay(
  propertyId: BasesPropertyId | null,
  raw: unknown,
  display: ProgressDisplay,
): ProgressOverlay {
  const percent = readPercent(propertyId, raw);
  if (percent === null) return NONE_OVERLAY;
  return { kind: "progress", percent, display };
}
