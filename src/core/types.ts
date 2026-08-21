// Shared domain types for the e-reader plugin. No logic lives here — only
// the shapes other modules (locator, settings, library, reader, sidebar)
// agree on. See specs/001-bases-ereader/data-model.md for the authoritative
// field-by-field description.

import type { TFile } from "obsidian";

/**
 * A book note's reading status. Absent on a Book means "no overlay" — it
 * must never be inferred from `progress` (data-model.md, Book validation).
 */
export type ReadState = "unread" | "reading" | "finished";

/**
 * The type of an annotation entry (highlight or bookmark). Reader-configurable
 * beyond the reserved value below (FR-020a).
 */
export type EntryType = string;

/**
 * `bookmark` is a reserved EntryType: it must never be offered as, or added
 * to, the reader-configurable set of highlight types (FR-020a, FR-028a).
 */
export const RESERVED_ENTRY_TYPE: EntryType = "bookmark";

/**
 * A serialisable reading position. A hint, not an authority (data-model.md,
 * Locator) — highlight anchoring verifies it against quoted text rather than
 * trusting it outright.
 */
export type Locator =
  | { kind: "epub"; cfi: string }
  | { kind: "pdf"; page: number; offset?: number };

/**
 * The anchor a highlight or bookmark carries for re-locating itself in the
 * source text (data-model.md, Highlight). `hint` is the fast path only;
 * `prefix`/`suffix` disambiguate when `exact` alone is not unique.
 */
export interface AnchorRecord {
  id: string;
  prefix?: string;
  suffix?: string;
  hint?: Locator;
  /** ISO 8601 datetime; sort key when anchoring fails. */
  created: string;
}

/**
 * A resolved book-note view model: a Book note's frontmatter, read through
 * the reader's configured property names (settings-model.ts) and normalised
 * into a stable shape for the library/reader/sidebar to consume.
 */
export interface Book {
  file: TFile;
  title: string;
  attachments: TFile[];
  cover?: string;
  author?: string[];
  readState?: ReadState;
  /** 0–100. */
  progress?: number;
  published?: string;
  source?: string;
  description?: string;
  tags?: string[];
  lastRead?: Locator;
  furthestRead?: Locator;
}
