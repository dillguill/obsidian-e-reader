// Pure logic deciding what read-state and progress overlays to render on a
// library card. No DOM; no runtime dependency on `obsidian` (BasesPropertyId
// is imported as a type only, so it is erased at compile time).
//
// Read state and progress are decided by two entirely separate functions
// with disjoint inputs, so neither can ever be inferred from the other
// (data-model.md, Book validation: "must never be inferred from progress
// and vice versa").
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

const READ_STATES: readonly ReadState[] = ["unread", "reading", "finished"];
const NONE_OVERLAY = { kind: "none" } as const;

function isBoundProperty(propertyId: BasesPropertyId | null): propertyId is BasesPropertyId {
  return propertyId !== null;
}

/** True for a value shaped like what a real Bases `Value` becomes once stringified/numberised. */
function isUsableScalar(raw: unknown): raw is string | number {
  return typeof raw === "string" || typeof raw === "number";
}

export function decideReadStateOverlay(propertyId: BasesPropertyId | null, raw: unknown): ReadStateOverlay {
  if (!isBoundProperty(propertyId)) return NONE_OVERLAY;
  if (typeof raw !== "string") return NONE_OVERLAY;
  const value = raw.trim();
  if (value === "") return NONE_OVERLAY;
  if ((READ_STATES as readonly string[]).includes(value)) {
    return { kind: "read-state", state: value as ReadState };
  }
  return NONE_OVERLAY;
}

export function decideProgressOverlay(
  propertyId: BasesPropertyId | null,
  raw: unknown,
  display: ProgressDisplay,
): ProgressOverlay {
  if (!isBoundProperty(propertyId)) return NONE_OVERLAY;
  if (!isUsableScalar(raw)) return NONE_OVERLAY;
  if (typeof raw === "string" && raw.trim() === "") return NONE_OVERLAY;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return NONE_OVERLAY;
  const percent = Math.min(100, Math.max(0, numeric));
  return { kind: "progress", percent, display };
}
