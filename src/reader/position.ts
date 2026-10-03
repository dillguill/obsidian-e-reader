// Pure decision logic for writing reading position back to the book note's
// frontmatter (progress, last-read and furthest-read). Kept free of app/vault/timer
// dependencies so it can be unit tested directly; src/reader/reader-view.ts
// is the only caller and owns the actual setInterval/processFrontMatter I/O.

import { compareLocators, parseLocator } from "../core/locator";
import type { Locator } from "../core/types";

export interface ReadingPosition {
  /** 0–100. */
  progress: number;
  /** Serialised Locator (core/locator.ts). */
  locator: string;
}

/**
 * Whether `next` differs from the last-written position and is therefore
 * worth persisting. `null` for `previous` means nothing has been written yet
 * this session, so any position counts as a change.
 */
export function positionChanged(previous: ReadingPosition | null, next: ReadingPosition): boolean {
  if (previous === null) return true;
  return previous.progress !== next.progress || previous.locator !== next.locator;
}

/**
 * Debounce decision: given how long it has been since the last flush and the
 * configured minimum interval, should a flush happen now? A non-positive
 * `minIntervalMs` always flushes immediately (debouncing disabled).
 */
export function shouldFlushNow(msSinceLastFlush: number, minIntervalMs: number): boolean {
  return minIntervalMs <= 0 || msSinceLastFlush >= minIntervalMs;
}

/**
 * The furthest-read value to store (FR-015a, FR-015c): the furthest of the
 * stored furthest position, the stored last-read position and where the
 * reader is now. The stored values are read inside the same frontmatter
 * write, so a position another device synced in since this book was opened
 * is compared rather than overwritten. A stored value that does not parse,
 * or belongs to the other format, is ignored.
 */
export function furthestOf(candidates: readonly unknown[], current: string): string {
  const now = parseLocator(current);
  if (now === null) return current;
  let best = now;
  let bestRaw = current;
  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const locator = parseLocator(raw);
    if (locator === null) continue;
    if (compareLocators(locator, best) === 1) {
      best = locator;
      bestRaw = raw;
    }
  }
  return bestRaw;
}

/**
 * Where to offer a jump to when a book opens (FR-015b): the furthest-read
 * position when it lies beyond the restored last-read one, otherwise null.
 * With no last-read position the book opens at its start, so any furthest
 * position is ahead of it.
 */
export function jumpTarget(lastRead: Locator | null, furthest: Locator | null): Locator | null {
  if (furthest === null) return null;
  if (lastRead === null) return furthest;
  return compareLocators(furthest, lastRead) === 1 ? furthest : null;
}
