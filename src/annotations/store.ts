// Reading and writing a book's annotation entries.
//
// Callout and quote entries live in the book note's region; note entries are
// notes of their own (highlight-notes.ts), which the region lists as links.
// Every function here takes both into account, so callers never need to know
// which format an entry was written in, and changing the format setting only
// affects entries written afterwards.
//
// Every write to the book note goes through `Vault.process`, which reads and
// replaces the file in one atomic step, so a highlight created while the note
// is open in another pane cannot clobber an edit made there. Writes only ever
// touch the text between the region markers (region.ts).

import type { App, TFile } from "obsidian";
import type { AnchorRecord, Locator } from "../core/types";
import type { HighlightSettings } from "../settings/settings-model";
import { type Entry, type MalformedEntry, newEntryId, serializeEntry } from "./entry";
import {
  type NoteDetails,
  type NoteEntry,
  createHighlightNote,
  jumpLink,
  linkList,
  listHighlightNotes,
  updateHighlightNote,
} from "./highlight-notes";
import { type LocatedEntry, locateEntries } from "./locate";
import { findRegion, writeRegion } from "./region";

/** Bookmarks mark a place rather than a passage; a note each would be clutter, so they always stay in the region. */
const BOOKMARK_TYPE = "bookmark";

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

export async function listEntries(app: App, note: TFile, settings: HighlightSettings): Promise<EntryListing> {
  const text = await app.vault.cachedRead(note);
  const cache = app.metadataCache.getFileCache(note);
  const located = locateEntries(text, cache);
  const notes = await listHighlightNotes(app, note, settings);
  return {
    entries: [...located.entries.map((item) => item.entry), ...notes.map((item) => item.entry)],
    malformed: located.malformed,
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

/** Writes a new entry in the configured format. Returns it. */
export async function addEntry(
  app: App,
  note: TFile,
  draft: EntryDraft,
  settings: HighlightSettings,
  now: Date = new Date(),
  random: () => number = Math.random,
): Promise<Entry> {
  const entry = buildEntry(draft, now, random);
  if (settings.format === "note" && draft.type !== BOOKMARK_TYPE) {
    const details: NoteDetails = {};
    if (draft.page !== undefined) details.page = draft.page;
    if (draft.section !== undefined) details.section = draft.section;
    const created = { ...entry, format: "note" as const };
    const file = await createHighlightNote(app, note, created, details, settings);
    // The metadata cache indexes the new note in its own time; it is listed now rather than on the next write.
    await rewriteEntries(app, note, settings, (entries) => entries, [{ entry: created, file }]);
    return { ...entry, format: "note" };
  }
  if (settings.format === "quote") entry.format = "quote";
  const block = serializeEntry(entry, jumpLink(app, note, entry));
  await app.vault.process(note, (text) => {
    const region = findRegion(text);
    const body = region === null || region.body === "" ? block : `${region.body}\n\n${block}`;
    return writeRegion(text, body);
  });
  return entry;
}

/**
 * Rewrites the region with `mutate` applied to the located entries, followed
 * by the links to the book's highlight notes. Anything that failed to parse
 * is left exactly as it was found (contract rule 7), so a hand-edit this
 * plugin cannot read is never destroyed by a later write.
 */
async function rewriteEntries(
  app: App,
  note: TFile,
  settings: HighlightSettings,
  mutate: (entries: LocatedEntry[]) => LocatedEntry[],
  justCreated: readonly NoteEntry[] = [],
): Promise<void> {
  const listed = await listHighlightNotes(app, note, settings);
  const notes = [...listed, ...justCreated.filter((item) => !listed.some((other) => other.entry.id === item.entry.id))];
  await app.vault.process(note, (text) => {
    const region = findRegion(text);
    if (region === null && notes.length === 0) return text;
    const located = locateEntries(text, app.metadataCache.getFileCache(note));
    // Offsets come from the cache, which describes the file as last indexed.
    // If the text moved underneath us the ranges no longer line up, and the
    // safe answer is to leave the note alone until the cache catches up.
    const stale = located.entries.some((item) => !text.slice(item.start, item.end).trimStart().startsWith(">"));
    if (stale) return text;
    const kept = mutate(located.entries);
    const body = kept.map((item) => serializeEntry(item.entry, jumpLink(app, note, item.entry))).join("\n");
    const preserved = located.malformed
      .map((item) => item.raw)
      .filter((raw) => raw !== "")
      .join("\n\n");
    const combined = [body.trim(), preserved, linkList(app, note, notes)].filter((part) => part !== "").join("\n\n");
    return writeRegion(text, combined);
  });
}

async function findNoteEntry(app: App, note: TFile, id: string, settings: HighlightSettings): Promise<NoteEntry | null> {
  return (await listHighlightNotes(app, note, settings)).find((item) => item.entry.id === id) ?? null;
}

export async function removeEntry(app: App, note: TFile, id: string, settings: HighlightSettings): Promise<void> {
  const owned = await findNoteEntry(app, note, id, settings);
  if (owned) await app.fileManager.trashFile(owned.file);
  await rewriteEntries(app, note, settings, (entries) => entries.filter((item) => item.entry.id !== id));
}

export async function setEntryComment(app: App, note: TFile, id: string, comment: string, settings: HighlightSettings): Promise<void> {
  const owned = await findNoteEntry(app, note, id, settings);
  if (owned) {
    await updateHighlightNote(app, note, owned, { ...owned.entry, comment }, settings);
    return;
  }
  await rewriteEntries(app, note, settings, (entries) =>
    entries.map((item) => (item.entry.id === id ? { ...item, entry: { ...item.entry, comment } } : item)),
  );
}

export async function setEntryType(app: App, note: TFile, id: string, type: string, settings: HighlightSettings): Promise<void> {
  const owned = await findNoteEntry(app, note, id, settings);
  if (owned) {
    await updateHighlightNote(app, note, owned, { ...owned.entry, type }, settings);
    return;
  }
  await rewriteEntries(app, note, settings, (entries) =>
    entries.map((item) => (item.entry.id === id ? { ...item, entry: { ...item.entry, type } } : item)),
  );
}
