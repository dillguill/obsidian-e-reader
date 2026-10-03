// Reading and writing a book's annotation entries.
//
// A highlight lives in one of two places, chosen by the highlight mode:
// written into the book note's region (as a callout or a plain quote), or as
// a note of its own (highlight-notes.ts). Bookmarks live in a list property
// on the book note (bookmarks.ts). Every function here reads all three, so
// callers never need to know where an entry is, and changing the mode only
// affects entries written afterwards until the reader moves the old ones
// (moveToNotes, moveToBookNote).
//
// Every write to the book note goes through `Vault.process`, which reads and
// replaces the file in one atomic step, so a highlight created while the note
// is open in another pane cannot clobber an edit made there. Writes only ever
// touch the text between the region markers (region.ts), apart from moving
// highlights out of or into the note, which also removes or adds the region
// and the embedded highlights view.

import type { App, TFile } from "obsidian";
import type { AnchorRecord, Locator } from "../core/types";
import { RESERVED_ENTRY_TYPE } from "../core/types";
import type { Settings } from "../settings/settings-model";
import { addBookmarks, isBookmarkId, listBookmarks, removeBookmark } from "./bookmarks";
import { type Entry, type EntryFormat, type MalformedEntry, newEntryId, serializeEntry } from "./entry";
import {
  type NoteDetails,
  type NoteEntry,
  createHighlightNote,
  ensureEmbed,
  jumpLink,
  listHighlightNotes,
  updateHighlightNote,
  withoutEmbed,
} from "./highlight-notes";
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
      // A highlight half-way through moving can briefly be in both places.
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
  return { id, type: draft.type, exact: draft.exact, comment: draft.comment ?? "", anchor };
}

function detailsOf(entry: Entry, draft?: NoteDetails): NoteDetails {
  const details: NoteDetails = {};
  const page = draft?.page ?? (entry.anchor.hint?.kind === "pdf" ? entry.anchor.hint.page : undefined);
  if (page !== undefined) details.page = page;
  if (draft?.section !== undefined) details.section = draft.section;
  return details;
}

function blockFor(app: App, entry: Entry, settings: Settings): string {
  return serializeEntry(entry, settings.highlights.pageLinks ? jumpLink(app, entry) : null);
}

/** Writes a new entry where the settings say. Returns it. */
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
  if (settings.highlights.mode === "notes") {
    const created: Entry = { ...entry, format: "note" };
    const file = await createHighlightNote(app, note, created, detailsOf(entry, draft), settings.highlights);
    await ensureEmbed(app, note, settings.highlights);
    return { ...created, source: file.path };
  }
  if (settings.highlights.style === "quote") entry.format = "quote";
  const block = blockFor(app, entry, settings);
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
    const body = kept.map((entry) => blockFor(app, entry, settings)).join("\n");
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

async function findNoteEntry(app: App, note: TFile, id: string, settings: Settings): Promise<NoteEntry | null> {
  return (await listHighlightNotes(app, note, settings.highlights)).find((item) => item.entry.id === id) ?? null;
}

async function inRegion(app: App, note: TFile, id: string): Promise<boolean> {
  return (await regionEntries(app, note)).entries.some((entry) => entry.id === id);
}

export async function removeEntry(app: App, note: TFile, id: string, settings: Settings): Promise<void> {
  if (isBookmarkId(id)) {
    await removeBookmark(app, note, id, settings.properties.bookmarks);
    return;
  }
  if (await inRegion(app, note, id)) {
    await rewriteRegion(app, note, settings, (entries) => entries.filter((item) => item.entry.id !== id));
  }
  const owned = await findNoteEntry(app, note, id, settings);
  if (owned) await app.fileManager.trashFile(owned.file);
}

async function updateEntry(app: App, note: TFile, id: string, settings: Settings, change: (entry: Entry) => Entry): Promise<void> {
  if (isBookmarkId(id)) return;
  if (await inRegion(app, note, id)) {
    await rewriteRegion(app, note, settings, (entries) =>
      entries.map((item) => (item.entry.id === id ? { ...item, entry: change(item.entry) } : item)),
    );
    return;
  }
  const owned = await findNoteEntry(app, note, id, settings);
  if (owned) await updateHighlightNote(app, owned, change(owned.entry), settings.highlights);
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
 * Moves every highlight in the book note into notes of its own, and embeds
 * the highlights view in its place. All or nothing for the book: if any note
 * cannot be written, the ones already written are removed again and the
 * book note is left as it was. Returns how many moved.
 */
export async function moveToNotes(app: App, note: TFile, settings: Settings): Promise<number> {
  await migrateBookmarks(app, note, settings);
  const moving = (await regionEntries(app, note)).entries.filter((entry) => entry.type !== RESERVED_ENTRY_TYPE);
  if (moving.length === 0) return 0;
  const created: TFile[] = [];
  try {
    for (const entry of moving) {
      created.push(await createHighlightNote(app, note, { ...entry, format: "note" }, detailsOf(entry), settings.highlights));
    }
    const ids = new Set(moving.map((entry) => entry.id));
    await rewriteRegion(app, note, settings, (located) => located.filter((item) => !ids.has(item.entry.id)), {
      dropIfEmpty: true,
    });
  } catch (error) {
    for (const file of created) await app.fileManager.trashFile(file);
    throw error;
  }
  await ensureEmbed(app, note, settings.highlights);
  return moving.length;
}

/**
 * Moves every highlight note of the book into the book note, in the
 * configured style, and removes the embedded highlights view. The notes are
 * only deleted once the book note holds their highlights. Returns how many
 * moved.
 */
export async function moveToBookNote(app: App, note: TFile, settings: Settings): Promise<number> {
  const notes = await listHighlightNotes(app, note, settings.highlights);
  if (notes.length === 0) return 0;
  const style: EntryFormat | undefined = settings.highlights.style === "quote" ? "quote" : undefined;
  const added = notes.map(({ entry }): Entry => {
    const { source: _source, format: _format, ...rest } = entry;
    return style ? { ...rest, format: style } : rest;
  });
  await rewriteRegion(app, note, settings, (located) => located, { added, edit: withoutEmbed });
  for (const item of notes) await app.fileManager.trashFile(item.file);
  return notes.length;
}

/** Renames a highlight type throughout one book, wherever its highlights live. Returns how many changed. */
export async function renameTypeInBook(app: App, note: TFile, from: string, to: string, settings: Settings): Promise<number> {
  let count = 0;
  const region = await regionEntries(app, note);
  const inNote = region.entries.filter((entry) => entry.type === from).length;
  if (inNote > 0) {
    await rewriteRegion(app, note, settings, (entries) =>
      entries.map((item) => (item.entry.type === from ? { ...item, entry: { ...item.entry, type: to } } : item)),
    );
    count += inNote;
  }
  for (const item of await listHighlightNotes(app, note, settings.highlights)) {
    if (item.entry.type !== from) continue;
    await updateHighlightNote(app, item, { ...item.entry, type: to }, settings.highlights);
    count++;
  }
  return count;
}
