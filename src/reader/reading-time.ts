// Time left in the chapter and the book, and how the reader's pace is learned.
//
// Both formats count their position in units the toolbar already shows — a
// PDF's pages, an EPUB's generated locations — so a chapter is a span of
// units and the time left is units remaining × time per unit. The time per
// unit starts from a typical reading speed and is then learned from the
// reader's own page turns, the way dedicated reading apps do it.
//
// Pure, so the arithmetic is tested without a reader (tests/unit/reading-time.test.ts).

/**
 * An EPUB location is about 1,600 characters (epub/adapter.ts generates them
 * at that size): some 270 words, a little over a minute at 250 words a
 * minute.
 */
export const DEFAULT_PACE_EPUB_MS = 65_000;
/** A printed book's page holds roughly 300 words. */
export const DEFAULT_PACE_PDF_MS = 75_000;

/** A unit read faster than this was skimmed past; slower, the reader walked away. */
const MIN_PACE_MS = 5_000;
const MAX_PACE_MS = 10 * 60_000;
/** A forward step of more than this many units at once is a jump, not reading. */
const MAX_STEP_UNITS = 3;
/** How much one sample moves the learned pace. */
const PACE_WEIGHT = 0.2;

export function clampPace(ms: number): number {
  return Math.min(MAX_PACE_MS, Math.max(MIN_PACE_MS, ms));
}

/**
 * The learned pace after the reader moved from `fromUnit` to `toUnit` in
 * `elapsedMs`, or null when that move says nothing about their reading
 * speed: going backwards, standing still, jumping ahead, or a gap long enough
 * that they plainly put the book down.
 */
export function nextPace(pace: number, fromUnit: number, toUnit: number, elapsedMs: number): number | null {
  const step = toUnit - fromUnit;
  if (step <= 0 || step > MAX_STEP_UNITS) return null;
  const sample = elapsedMs / step;
  if (sample < MIN_PACE_MS || sample > MAX_PACE_MS) return null;
  return clampPace(pace + (sample - pace) * PACE_WEIGHT);
}

/** One table-of-contents entry, already placed on the unit scale. */
export interface ChapterStart {
  label: string;
  /** The unit it starts at, or null when the engine cannot place it yet. */
  unit: number | null;
  /** 0 for a top-level entry. Only top-level entries get a tick on the progress bar. */
  depth?: number;
}

export interface ChapterSpan {
  label: string;
  /** First unit of the chapter. */
  start: number;
  /** First unit of the next chapter, or one past the book's last. */
  end: number;
}

/**
 * The chapter the reader is in: the last placed entry at or before
 * `current`, ending where the next entry that starts later begins. Nested
 * entries count as chapters of their own, since a sub-chapter is what the
 * reader is actually inside. Null before the first entry, or with none.
 */
export function chapterAt(starts: readonly ChapterStart[], current: number, total: number): ChapterSpan | null {
  const placed = starts
    .filter((entry): entry is { label: string; unit: number } => entry.unit !== null)
    .slice()
    .sort((a, b) => a.unit - b.unit);
  let index = -1;
  for (let i = 0; i < placed.length; i++) {
    if ((placed[i] as { unit: number }).unit <= current) index = i;
  }
  if (index < 0) return null;
  const chapter = placed[index] as { label: string; unit: number };
  const next = placed.slice(index + 1).find((entry) => entry.unit > chapter.unit);
  return { label: chapter.label, start: chapter.unit, end: next ? next.unit : total + 1 };
}

/**
 * Where every contents entry starts along the book's progress bar, as 0–1,
 * with the depth of the shallowest entry starting there. The start of the
 * bar gets no tick, and entries starting on the same unit share one.
 */
export function chapterTicks(starts: readonly ChapterStart[], total: number): { at: number; depth: number }[] {
  if (total <= 1) return [];
  const depths = new Map<number, number>();
  for (const entry of starts) {
    if (entry.unit === null || entry.unit <= 1 || entry.unit > total) continue;
    const depth = entry.depth ?? 0;
    depths.set(entry.unit, Math.min(depth, depths.get(entry.unit) ?? depth));
  }
  return [...depths.entries()].sort((a, b) => a[0] - b[0]).map(([unit, depth]) => ({ at: (unit - 1) / (total - 1), depth }));
}

/**
 * The top-level chapter to move to from unit `current`, as an index into
 * `starts`: the next one that starts after it, or going back, the last one
 * that starts before it — the start of this chapter when the reader is part
 * way in, and the one before when they are already at its start.
 */
export function adjacentChapter(starts: readonly ChapterStart[], current: number, direction: 1 | -1): number | null {
  let found: number | null = null;
  starts.forEach((entry, index) => {
    if ((entry.depth ?? 0) !== 0 || entry.unit === null) return;
    if (direction === 1 && entry.unit > current) {
      if (found === null || entry.unit < (starts[found]?.unit ?? Infinity)) found = index;
    } else if (direction === -1 && entry.unit < current) {
      if (found === null || entry.unit >= (starts[found]?.unit ?? -Infinity)) found = index;
    }
  });
  return found;
}

/** 0–1 through a chapter. */
export function chapterFraction(chapter: ChapterSpan, current: number): number {
  const length = chapter.end - chapter.start;
  if (length <= 0) return 1;
  return Math.min(1, Math.max(0, (current - chapter.start) / length));
}

/**
 * Units still to read, counting the one on screen as half read: the reader is
 * somewhere inside it, and counting it whole or not at all makes the last
 * page of a chapter read as either a minute left or none.
 */
export function unitsLeft(current: number, end: number): number {
  return Math.max(0, end - current - 0.5);
}

/** `under a minute`, `12 min`, `3 h 5 min`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** What the progress line's second row can show; a tap moves to the next. */
export type ProgressInfo = "chapter" | "chapter-time" | "book-time";

export interface ProgressFacts {
  /** The chapter the reader is in, when the contents place them in one. */
  chapter: { label: string; fraction: number; msLeft: number } | null;
  bookMsLeft: number;
}

/**
 * The progress line's second row. A chapter choice in a book whose contents
 * do not place the reader in a chapter falls back to the time left in the
 * book, since the book's percentage is already on the row above.
 */
export function progressInfoLabel(info: ProgressInfo, facts: ProgressFacts): string {
  const chapter = facts.chapter;
  switch (info) {
    case "chapter":
      if (chapter) return `${chapter.label} · ${Math.round(chapter.fraction * 100)}%`;
      return `${formatDuration(facts.bookMsLeft)} left in book`;
    case "chapter-time":
      if (chapter) return `${formatDuration(chapter.msLeft)} left in chapter`;
      return `${formatDuration(facts.bookMsLeft)} left in book`;
    default:
      return `${formatDuration(facts.bookMsLeft)} left in book`;
  }
}
