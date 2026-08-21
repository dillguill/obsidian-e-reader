// Finding this plugin's entries inside a book note.
//
// Discovery goes through Obsidian's metadata cache, never through a
// hand-rolled markdown parser (contract, "Locating entries"). `blocks` is the
// authority on whether an `^id` actually attached to anything; `sections`
// says what kind of block it attached to.
//
// The two are cross-checked rather than trusted individually: depending on
// how the parser treats an identifier that sits on its own line beneath a
// blockquote, `blocks[id]` may point either at the blockquote itself or at
// the identifier line alone. Both are handled here so entry lookup does not
// depend on which.

import type { CachedMetadata, SectionCache } from "obsidian";
import { type Entry, type MalformedEntry, parseEntry } from "./entry";

/** Entry ids this plugin issues all start here (contracts/highlight-entry.md). */
export const ENTRY_ID_PREFIX = "h-";

const STRUCTURED_TYPES = new Set(["blockquote", "callout", "quote"]);

export interface LocatedEntry {
  entry: Entry;
  /** Offsets of the entry's blockquote within the note text. */
  start: number;
  end: number;
}

export interface LocateResult {
  entries: LocatedEntry[];
  /** Entries that parsed badly. Reported, never rewritten or removed (contract rule 7). */
  malformed: MalformedEntry[];
}

function isStructured(section: SectionCache): boolean {
  return STRUCTURED_TYPES.has(section.type);
}

/**
 * The blockquote an entry id refers to. Falls back to the nearest preceding
 * structured section when the id resolved to a bare identifier line.
 */
function sectionForId(cache: CachedMetadata, id: string): SectionCache | null {
  const sections = cache.sections ?? [];
  const owning = sections.find((section) => section.id === id);
  if (owning && isStructured(owning)) return owning;

  const block = cache.blocks?.[id];
  if (!block) return null;

  const at = sections.findIndex((section) => section.position.start.offset === block.position.start.offset);
  if (at === -1) return owning ?? null;
  if (isStructured(sections[at] as SectionCache)) return sections[at] as SectionCache;

  for (let i = at - 1; i >= 0; i--) {
    const candidate = sections[i] as SectionCache;
    if (isStructured(candidate)) return candidate;
    // Only a blank gap may separate the identifier from its block; anything
    // else means this id belongs to unrelated content.
    if (candidate.type !== "paragraph") break;
  }
  return null;
}

/** Strips a trailing `^id` line, present when the id sits inside the sliced range. */
function withoutIdLine(text: string, id: string): string {
  return text.replace(new RegExp(`\\n\\s*\\^${id}\\s*$`), "");
}

/**
 * All of this plugin's entries in `noteText`, in the order they appear.
 * `cache` must be the metadata cache for the same revision of the note —
 * pass the text from `vault.cachedRead` alongside
 * `metadataCache.getFileCache`.
 */
export function locateEntries(noteText: string, cache: CachedMetadata | null): LocateResult {
  const result: LocateResult = { entries: [], malformed: [] };
  if (!cache?.blocks) return result;

  const ids = Object.keys(cache.blocks)
    .filter((id) => id.startsWith(ENTRY_ID_PREFIX))
    .sort((a, b) => (cache.blocks?.[a]?.position.start.offset ?? 0) - (cache.blocks?.[b]?.position.start.offset ?? 0));

  for (const id of ids) {
    const section = sectionForId(cache, id);
    if (!section) {
      result.malformed.push({ id, reason: "block identifier is not attached to a quote", raw: "" });
      continue;
    }
    const start = section.position.start.offset;
    const end = section.position.end.offset;
    const raw = withoutIdLine(noteText.slice(start, end), id);
    const parsed = parseEntry(raw, id);
    if (parsed.ok) {
      result.entries.push({ entry: parsed.entry, start, end });
    } else {
      result.malformed.push(parsed.malformed);
    }
  }
  return result;
}
