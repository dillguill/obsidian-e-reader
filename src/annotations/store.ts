// Reading and writing a book note's annotation entries.
//
// Every write goes through `Vault.process`, which reads and replaces the file
// in one atomic step, so a highlight created while the note is open in
// another pane cannot clobber an edit made there. Writes only ever touch the
// text between the region markers (region.ts).

import type { App, TFile } from "obsidian";
import type { AnchorRecord, Locator } from "../core/types";
import { type Entry, type MalformedEntry, newEntryId, serializeEntry } from "./entry";
import { type LocatedEntry, locateEntries } from "./locate";
import { findRegion, writeRegion } from "./region";

export interface EntryDraft {
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

export async function listEntries(app: App, note: TFile): Promise<EntryListing> {
  const text = await app.vault.cachedRead(note);
  const cache = app.metadataCache.getFileCache(note);
  const located = locateEntries(text, cache);
  return { entries: located.entries.map((item) => item.entry), malformed: located.malformed };
}

function buildEntry(draft: EntryDraft, now: Date, random: () => number): Entry {
  const id = newEntryId(random);
  const anchor: AnchorRecord = { id, created: now.toISOString() };
  if (draft.prefix !== undefined && draft.prefix !== "") anchor.prefix = draft.prefix;
  if (draft.suffix !== undefined && draft.suffix !== "") anchor.suffix = draft.suffix;
  if (draft.hint !== undefined) anchor.hint = draft.hint;
  return { id, type: draft.type, exact: draft.exact, comment: draft.comment ?? "", anchor };
}

/** Appends an entry to the note's region, creating the region if needed. Returns the new entry. */
export async function addEntry(
  app: App,
  note: TFile,
  draft: EntryDraft,
  now: Date = new Date(),
  random: () => number = Math.random,
): Promise<Entry> {
  const entry = buildEntry(draft, now, random);
  const block = serializeEntry(entry);
  await app.vault.process(note, (text) => {
    const region = findRegion(text);
    const body = region === null || region.body === "" ? block : `${region.body}\n\n${block}`;
    return writeRegion(text, body);
  });
  return entry;
}

/**
 * Rewrites the region with `mutate` applied to the located entries. Anything
 * that failed to parse is left exactly as it was found (contract rule 7), so
 * a hand-edit this plugin cannot read is never destroyed by a later write.
 */
async function rewriteEntries(app: App, note: TFile, mutate: (entries: LocatedEntry[]) => LocatedEntry[]): Promise<void> {
  await app.vault.process(note, (text) => {
    const region = findRegion(text);
    if (region === null) return text;
    const located = locateEntries(text, app.metadataCache.getFileCache(note));
    // Offsets come from the cache, which describes the file as last indexed.
    // If the text moved underneath us the ranges no longer line up, and the
    // safe answer is to leave the note alone until the cache catches up.
    const stale = located.entries.some((item) => !text.slice(item.start, item.end).trimStart().startsWith(">"));
    if (stale) return text;
    const kept = mutate(located.entries);
    const body = kept.map((item) => serializeEntry(item.entry)).join("\n");
    const preserved = located.malformed
      .map((item) => item.raw)
      .filter((raw) => raw !== "")
      .join("\n\n");
    const combined = [body.trim(), preserved].filter((part) => part !== "").join("\n\n");
    return writeRegion(text, combined);
  });
}

export async function removeEntry(app: App, note: TFile, id: string): Promise<void> {
  await rewriteEntries(app, note, (entries) => entries.filter((item) => item.entry.id !== id));
}

export async function setEntryComment(app: App, note: TFile, id: string, comment: string): Promise<void> {
  await rewriteEntries(app, note, (entries) =>
    entries.map((item) => (item.entry.id === id ? { ...item, entry: { ...item.entry, comment } } : item)),
  );
}

export async function setEntryType(app: App, note: TFile, id: string, type: string): Promise<void> {
  await rewriteEntries(app, note, (entries) =>
    entries.map((item) => (item.entry.id === id ? { ...item, entry: { ...item.entry, type } } : item)),
  );
}
