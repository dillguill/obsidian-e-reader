// Links to one highlight: the reader links (`obsidian://e-reader?id=…`) and
// the text a reader copies into their own notes.
//
// A reader link names only the entry id, so finding the book means finding
// the note that holds that id: a book note with a `^id` block (or, until it
// is folded back in, a beta highlight note whose anchor property names it).

import type { App, TFile } from "obsidian";
import type { HighlightSettings } from "../settings/settings-model";
import { type Entry, quoteLines } from "./entry";
import { anchorIdOf, attribution, bookOf } from "./highlight-notes";

/** The book note holding the entry `id`. */
export function findBookForEntry(app: App, id: string, settings: HighlightSettings): TFile | null {
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    if (cache.blocks?.[id]) return file;
    if (anchorIdOf(cache.frontmatter) === id) return bookOf(app, file, settings.properties.book);
  }
  return null;
}

/**
 * The highlight an exported note links back to (`[[Book#^id]]`) and the book
 * it is in, or null for any other note. Beta highlight notes are recognised
 * by their anchor property.
 */
export function highlightOfNote(app: App, file: TFile, settings: HighlightSettings): { id: string; book: TFile } | null {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return null;
  for (const link of cache.links ?? []) {
    const match = link.link.match(/^(.*)#\^([a-z0-9-]+)$/);
    if (!match) continue;
    const book = app.metadataCache.getFirstLinkpathDest(match[1] as string, file.path);
    if (book && app.metadataCache.getFileCache(book)?.blocks?.[match[2] as string]) return { id: match[2] as string, book };
  }
  const id = anchorIdOf(cache.frontmatter);
  const book = id === null ? null : bookOf(app, file, settings.properties.book);
  return id !== null && book ? { id, book } : null;
}

/** A link to the highlight's block in the book note. */
export function entryLink(app: App, book: TFile, entry: Entry): string {
  return app.fileManager.generateMarkdownLink(book, "", `#^${entry.id}`);
}

/** The label of the link back to the highlight in its book note. */
export const NOTE_LINK_LABEL = "View in book note";

/** The link back to the highlight in its book note, which copies and exports carry beside the source. */
export function noteLink(app: App, book: TFile, entry: Entry, sourcePath = ""): string {
  return app.fileManager.generateMarkdownLink(book, sourcePath, `#^${entry.id}`, NOTE_LINK_LABEL);
}

/**
 * The quote, as a plain quote or as a callout typed like the highlight, with
 * a blank quoted line, then its source line and the link back to the note:
 * `– [Dune, Book One, p. 35](obsidian://…) · [[Dune#^id|View in book note]]`.
 */
export function quoteBlock(app: App, book: TFile, entry: Entry, callout: boolean, sourcePath = ""): string {
  const lines = callout ? [`> [!${entry.type}]`] : [];
  if (entry.exact !== "") lines.push(...quoteLines(entry.exact), ">");
  lines.push(`> ${attribution(app, book, entry)} · ${noteLink(app, book, entry, sourcePath)}`);
  return lines.join("\n");
}

/** What Copy as quote and Copy as callout put on the clipboard: the block, then the comment under it. */
export function entryCopy(app: App, book: TFile, entry: Entry, callout: boolean): string {
  return [quoteBlock(app, book, entry, callout), entry.comment].filter((part) => part !== "").join("\n\n");
}
