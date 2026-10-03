// Bookmarks, kept as a list property on the book note.
//
// A bookmark marks a place rather than a passage, so it needs nothing but the
// position: each item of the property is a locator (`page=12`, or an EPUB
// CFI). Keeping them in a property rather than in the note body means they
// never clutter the note, and Bases can count or show them like any other
// property.
//
// The reader and the highlights pane treat bookmarks as entries like any
// other, so each one is given an entry id derived from its position (`b-`
// and a hash). The same position always gets the same id, which is all an id
// is used for here: finding the bookmark again to remove it.

import type { App, TFile } from "obsidian";
import { parseLocator, serializeLocator } from "../core/locator";
import { type Locator, RESERVED_ENTRY_TYPE } from "../core/types";
import type { Entry } from "./entry";

export const BOOKMARK_ID_PREFIX = "b-";

/** A stable id for the bookmark at `locator` (FNV-1a, 6 hex digits). */
export function bookmarkId(locator: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < locator.length; i++) {
    hash ^= locator.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${BOOKMARK_ID_PREFIX}${(hash & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function isBookmarkId(id: string): boolean {
  return id.startsWith(BOOKMARK_ID_PREFIX);
}

/** The property's items as strings, whether it holds a list or a single value. */
function itemsOf(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function entryFor(locator: Locator): Entry {
  const id = bookmarkId(serializeLocator(locator));
  return { id, type: RESERVED_ENTRY_TYPE, exact: "", comment: "", anchor: { id, created: "", hint: locator } };
}

/** The book's bookmarks as entries. Items that are not positions are skipped, not removed. */
export function readBookmarks(frontmatter: Record<string, unknown> | undefined, property: string): Entry[] {
  const entries: Entry[] = [];
  for (const item of itemsOf(frontmatter?.[property])) {
    const locator = parseLocator(item);
    if (locator) entries.push(entryFor(locator));
  }
  return entries;
}

export function listBookmarks(app: App, book: TFile, property: string): Entry[] {
  return readBookmarks(app.metadataCache.getFileCache(book)?.frontmatter, property);
}

/** Adds bookmarks at `locators`, skipping any already there. Returns the entries. */
export async function addBookmarks(app: App, book: TFile, locators: readonly Locator[], property: string): Promise<Entry[]> {
  await app.fileManager.processFrontMatter(book, (fm: Record<string, unknown>) => {
    const items = itemsOf(fm[property]);
    for (const locator of locators) {
      const value = serializeLocator(locator);
      if (!items.includes(value)) items.push(value);
    }
    fm[property] = items;
  });
  return locators.map(entryFor);
}

/** Removes the bookmark with entry id `id`. Returns whether there was one. */
export async function removeBookmark(app: App, book: TFile, id: string, property: string): Promise<boolean> {
  let removed = false;
  await app.fileManager.processFrontMatter(book, (fm: Record<string, unknown>) => {
    const items = itemsOf(fm[property]);
    const kept = items.filter((item) => {
      const locator = parseLocator(item);
      return locator === null || bookmarkId(serializeLocator(locator)) !== id;
    });
    removed = kept.length !== items.length;
    if (!removed) return;
    if (kept.length === 0) delete fm[property];
    else fm[property] = kept;
  });
  return removed;
}
