// Reading and writing a book's annotation entries.
//
// The book note is the one place highlights are stored: each is a callout in
// the plugin's region of the note (entry.ts), whose title links back to the
// page. Bookmarks live in a list property on the book note (bookmarks.ts).
// A highlight exported as a note of its own only embeds the callout, so it
// is never a second copy to keep in sync.
//
// Betas briefly stored highlights as notes of their own; foldHighlightNotes
// moves those back into the book note when the book is opened.
//
// Every write to the book note goes through `Vault.process`, which reads and
// replaces the file in one atomic step, so a highlight created while the note
// is open in another pane cannot clobber an edit made there. Writes only ever
// touch the text between the region markers (region.ts), apart from folding
// beta notes back in, which also removes the view 0.4.0-beta.1 embedded.

import type { App, TFile } from "obsidian";
import type { AnchorRecord, Locator } from "../core/types";
import { RESERVED_ENTRY_TYPE } from "../core/types";
import type { Settings } from "../settings/settings-model";
import { addBookmarks, isBookmarkId, listBookmarks, removeBookmark } from "./bookmarks";
import { type Entry, type MalformedEntry, newEntryId, serializeEntry } from "./entry";
import { type NoteDetails, attribution, linksToBook, listHighlightNotes, withoutEmbed } from "./highlight-notes";
import { type LocatedEntry, locateEntries } from "./locate";
import { findRegion, removeRegion, writeRegion } from "./region";

export interface EntryDraft extends NoteDetails {
  type: string;
  exact: string;
  comment?: string;
  prefix?: string;
  suffix?: string;
  hint?: Locator;
}

export interface EntryListing {
  entries: Entry[];
  malformed: MalformedEntry[];
}

/** The book note changed between reading and writing it; nothing was written. */
export class StaleNoteError extends Error {
  constructor(note: TFile) {
    super(`${note.path} changed while it was being updated. Nothing was changed; try again.`);
  }
}

async function regionEntries(app: App, note: TFile): Promise<{ entries: Entry[]; malformed: MalformedEntry[] }> {
  const text = await app.vault.cachedRead(note);
  const located = locateEntries(text, app.metadataCache.getFileCache(note));
  return { entries: located.entries.map((item) => item.entry), malformed: located.malformed };
}

export async function listEntries(app: App, note: TFile, settings: Settings): Promise<EntryListing> {
  const region = await regionEntries(app, note);
  const notes = await listHighlightNotes(app, note, settings.highlights);
  const seen = new Set(region.entries.map((entry) => entry.id));
  return {
    entries: [
      ...region.entries,
      // Beta highlight notes not yet folded back in, so nothing disappears meanwhile.
      ...notes.map((item) => item.entry).filter((entry) => !seen.has(entry.id)),
      ...listBookmarks(app, note, settings.properties.bookmarks),
    ],
    malformed: region.malformed,
  };
}

function buildEntry(draft: EntryDraft, now: Date, random: () => number): Entry {
  const id = newEntryId(random);
  const anchor: AnchorRecord = { id, created: now.toISOString() };
  if (draft.prefix !== undefined && draft.prefix !== "") anchor.prefix = draft.prefix;
  if (draft.suffix !== undefined && draft.suffix !== "") anchor.suffix = draft.suffix;
  if (draft.hint !== undefined) anchor.hint = draft.hint;
  if (draft.section !== undefined && draft.section !== "") anchor.section = draft.section;
  return { id, type: draft.type, exact: draft.exact, comment: draft.comment ?? "", anchor };
}

function blockFor(app: App, book: TFile, entry: Entry): string {
  return serializeEntry(entry, attribution(app, book, entry));
}

/** Writes a new highlight into the book note, or a bookmark into its bookmarks property. Returns it. */
export async function addEntry(
  app: App,
  note: TFile,
  draft: EntryDraft,
  settings: Settings,
  now: Date = new Date(),
  random: () => number = Math.random,
): Promise<Entry> {
  if (draft.type === RESERVED_ENTRY_TYPE) {
    if (!draft.hint) throw new Error("A bookmark needs a position, and the reader has none yet.");
    const [bookmark] = await addBookmarks(app, note, [draft.hint], settings.properties.bookmarks);
    return bookmark as Entry;
  }
  const entry = buildEntry(draft, now, random);
  const block = blockFor(app, note, entry);
  await app.vault.process(note, (text) => {
    const region = findRegion(text);
    const body = region === null || region.body === "" ? block : `${region.body}\n\n${block}`;
    return writeRegion(text, body);
  });
  return entry;
}

/**
 * Rewrites the region with `mutate` applied to the located entries and
 * `added` appended. Anything that failed to parse is left exactly as it was
 * found (contract rule 7), so a hand-edit this plugin cannot read is never
 * destroyed by a later write. With `dropIfEmpty`, a region left with nothing
 * in it is removed altogether.
 *
 * Throws StaleNoteError when the note no longer matches the metadata cache.
 */
async function rewriteRegion(
  app: App,
  note: TFile,
  settings: Settings,
  mutate: (entries: LocatedEntry[]) => LocatedEntry[],
  options: { added?: readonly Entry[]; dropIfEmpty?: boolean; edit?: (text: string) => string } = {},
): Promise<void> {
  let stale = false;
  await app.vault.process(note, (original) => {
    const located = locateEntries(original, app.metadataCache.getFileCache(note));
    // Offsets come from the cache, which describes the file as last indexed.
    // If the text moved underneath us the ranges no longer line up, and the
    // safe answer is to leave the note alone until the cache catches up.
    if (located.entries.some((item) => !original.slice(item.start, item.end).trimStart().startsWith(">"))) {
      stale = true;
      return original;
    }
    const text = options.edit ? options.edit(original) : original;
    const added = options.added ?? [];
    if (findRegion(text) === null && located.entries.length === 0 && added.length === 0) return text;
    const kept = [...mutate(located.entries).map((item) => item.entry), ...added];
    const body = kept.map((entry) => blockFor(app, note, entry)).join("\n");
    const preserved = located.malformed
      .map((item) => item.raw)
      .filter((raw) => raw !== "")
      .join("\n\n");
    const combined = [body.trim(), preserved].filter((part) => part !== "").join("\n\n");
    if (combined === "" && options.dropIfEmpty) return removeRegion(text);
    return writeRegion(text, combined);
  });
  if (stale) throw new StaleNoteError(note);
}

async function inRegion(app: App, note: TFile, id: string): Promise<boolean> {
  return (await regionEntries(app, note)).entries.some((entry) => entry.id === id);
}

export async function removeEntry(app: App, note: TFile, id: string, settings: Settings): Promise<void> {
  if (isBookmarkId(id)) {
    await removeBookmark(app, note, id, settings.properties.bookmarks);
    return;
  }
  await foldHighlightNotes(app, note, settings);
  if (await inRegion(app, note, id)) {
    await rewriteRegion(app, note, settings, (entries) => entries.filter((item) => item.entry.id !== id));
  }
}

async function updateEntry(app: App, note: TFile, id: string, settings: Settings, change: (entry: Entry) => Entry): Promise<void> {
  if (isBookmarkId(id)) return;
  // Fold first, so a highlight still in a beta note is edited where it now lives.
  await foldHighlightNotes(app, note, settings);
  if (await inRegion(app, note, id)) {
    await rewriteRegion(app, note, settings, (entries) =>
      entries.map((item) => (item.entry.id === id ? { ...item, entry: change(item.entry) } : item)),
    );
  }
}

export async function setEntryComment(app: App, note: TFile, id: string, comment: string, settings: Settings): Promise<void> {
  await updateEntry(app, note, id, settings, (entry) => ({ ...entry, comment }));
}

export async function setEntryType(app: App, note: TFile, id: string, type: string, settings: Settings): Promise<void> {
  await updateEntry(app, note, id, settings, (entry) => ({ ...entry, type }));
}

/**
 * Moves bookmarks written into the region before 0.4.0 to the bookmarks
 * property. Returns how many moved. A bookmark with no position cannot be a
 * property item and stays where it is.
 */
export async function migrateBookmarks(app: App, note: TFile, settings: Settings): Promise<number> {
  const { entries } = await regionEntries(app, note);
  const moving = entries.filter((entry) => entry.type === RESERVED_ENTRY_TYPE && entry.anchor.hint !== undefined);
  if (moving.length === 0) return 0;
  await addBookmarks(
    app,
    note,
    moving.map((entry) => entry.anchor.hint as Locator),
    settings.properties.bookmarks,
  );
  const ids = new Set(moving.map((entry) => entry.id));
  await rewriteRegion(app, note, settings, (located) => located.filter((item) => !ids.has(item.entry.id)), {
    dropIfEmpty: true,
  });
  return moving.length;
}

/**
 * Moves highlights stored in beta highlight notes into the book note as
 * callouts, and removes the view 0.4.0-beta.1 embedded. The notes are only
 * deleted once the book note holds their highlights. Returns how many moved.
 */
export async function foldHighlightNotes(app: App, note: TFile, settings: Settings): Promise<number> {
  const notes = await listHighlightNotes(app, note, settings.highlights);
  if (notes.length === 0) return 0;
  const added = notes.map(({ entry }): Entry => {
    const { source: _source, format: _format, ...rest } = entry;
    return rest;
  });
  await rewriteRegion(app, note, settings, (located) => located, { added, edit: withoutEmbed });
  for (const item of notes) await app.fileManager.trashFile(item.file);
  return notes.length;
}

/** Renames a highlight type throughout one book, including the type property of its exported notes. Returns how many highlights changed. */
export async function renameTypeInBook(app: App, note: TFile, from: string, to: string, settings: Settings): Promise<number> {
  await foldHighlightNotes(app, note, settings);
  let count = 0;
  const region = await regionEntries(app, note);
  const inNote = region.entries.filter((entry) => entry.type === from).length;
  if (inNote > 0) {
    await rewriteRegion(app, note, settings, (entries) =>
      entries.map((item) => (item.entry.type === from ? { ...item, entry: { ...item.entry, type: to } } : item)),
    );
    count += inNote;
  }
  const typeProperty = settings.highlights.properties.type;
  for (const file of exportedNotes(app, note, settings)) {
    if (app.metadataCache.getFileCache(file)?.frontmatter?.[typeProperty] !== from) continue;
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[typeProperty] = to;
    });
  }
  return count;
}

/**
 * Moves everything `from` holds into `into`, for two notes that turned out to
 * be one book: its highlights join `into`'s, frontmatter `into` lacks is
 * filled in and lists are joined, anything else written in it is appended
 * under a heading naming it, and exported highlight notes are pointed at
 * `into`. `from` then goes to the trash, the way the vault is set to delete.
 */
export async function mergeBookInto(app: App, from: TFile, into: TFile, settings: Settings): Promise<void> {
  await foldHighlightNotes(app, from, settings);
  const source = await regionEntries(app, from);
  const existing = new Set((await regionEntries(app, into)).entries.map((entry) => entry.id));
  const added = source.entries.filter((entry) => !existing.has(entry.id));
  if (added.length > 0) await rewriteRegion(app, into, settings, (located) => located, { added });

  const { marker } = settings.properties;
  const fromFrontmatter = { ...(app.metadataCache.getFileCache(from)?.frontmatter ?? {}) } as Record<string, unknown>;
  await app.fileManager.processFrontMatter(into, (fm: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(fromFrontmatter)) {
      if (key === marker || key === "position") continue;
      fm[key] = mergedValue(fm[key], value);
    }
  });

  const text = await app.vault.read(from);
  const leftover = [
    removeRegion(text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")).trim(),
    ...source.malformed.map((item) => item.raw.trim()),
  ].filter((part) => part !== "");
  if (leftover.length > 0) {
    await app.vault.process(into, (current) => `${current.replace(/\s+$/, "")}\n\n## From ${from.basename}\n\n${leftover.join("\n\n")}\n`);
  }

  const bookProperty = settings.highlights.properties.book;
  for (const file of exportedNotes(app, from, settings)) {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      fm[bookProperty] = `[[${app.metadataCache.fileToLinktext(into, file.path, true)}]]`;
    });
  }
  await app.fileManager.trashFile(from);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

/** `into`'s value, or `from`'s where `into` has none; two lists are joined without repeats. */
function mergedValue(into: unknown, from: unknown): unknown {
  if (isBlank(into)) return from;
  if (Array.isArray(into) && Array.isArray(from)) {
    const seen = new Set(into.map((item) => JSON.stringify(item)));
    return [...into, ...from.filter((item) => !seen.has(JSON.stringify(item)))];
  }
  return into;
}

/** Notes whose book property links to `note`: exported highlight notes, among others. */
function exportedNotes(app: App, note: TFile, settings: Settings): TFile[] {
  const found: TFile[] = [];
  for (const [path, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!targets[note.path] || path === note.path) continue;
    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !("extension" in file) || (file as TFile).extension !== "md") continue;
    if (linksToBook(app, file as TFile, note, settings.highlights.properties.book)) found.push(file as TFile);
  }
  return found;
}

/**
 * Records the chapter or section of highlights saved before it was kept,
 * from `sectionOf` (the reader's table of contents). Rewrites the region only
 * when there is something to add. Returns how many were filled in.
 */
export async function fillSections(
  app: App,
  note: TFile,
  settings: Settings,
  sectionOf: (entry: Entry) => Promise<string | undefined>,
): Promise<number> {
  const { entries } = await regionEntries(app, note);
  const found = new Map<string, string>();
  for (const entry of entries) {
    if (entry.anchor.section !== undefined || !entry.anchor.hint || entry.type === RESERVED_ENTRY_TYPE) continue;
    const section = await sectionOf(entry);
    if (section !== undefined && section !== "") found.set(entry.id, section);
  }
  if (found.size === 0) return 0;
  await rewriteRegion(app, note, settings, (located) =>
    located.map((item) => {
      const section = found.get(item.entry.id);
      return section === undefined ? item : { ...item, entry: { ...item.entry, anchor: { ...item.entry.anchor, section } } };
    }),
  );
  return found.size;
}
