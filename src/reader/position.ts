// Pure decision logic for writing reading position back to the book note's
// frontmatter (progress + last-read). Kept free of app/vault/timer
// dependencies so it can be unit tested directly; src/reader/reader-view.ts
// is the only caller and owns the actual setInterval/processFrontMatter I/O.

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
