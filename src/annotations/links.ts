// Links to one highlight: the reader links (`obsidian://e-reader?id=…`) and
// the text a reader copies into their own notes.
//
// A reader link names only the entry id, so finding the book means finding
// the note that holds that id: a book note with a `^id` block (or, until it
// is folded back in, a beta highlight note whose anchor property names it).

import type { App, TFile } from "obsidian";
import type { HighlightSettings } from "../settings/settings-model";
import { type Entry, quoteLines } from "./entry";
import { anchorIdOf, bookOf } from "./highlight-notes";

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

function blockLink(app: App, book: TFile, entry: Entry, label?: string): string {
  return app.fileManager.generateMarkdownLink(book, "", `#^${entry.id}`, label);
}

function pageLabel(entry: Entry): string {
  const hint = entry.anchor.hint;
  return hint?.kind === "pdf" ? `p. ${hint.page}` : "source";
}

/** A link to the highlight's block in the book note. */
export function entryLink(app: App, book: TFile, entry: Entry): string {
  return blockLink(app, book, entry);
}

/** The highlight as a plain quote, with a link back to its block. */
export function entryAsQuote(app: App, book: TFile, entry: Entry): string {
  return [...quoteLines(entry.exact), `> — ${blockLink(app, book, entry, pageLabel(entry))}`].join("\n");
}

/** The highlight as a callout typed like the highlight, with a link back to its block in the title. */
export function entryAsCallout(app: App, book: TFile, entry: Entry): string {
  const title = `${entry.type.charAt(0).toUpperCase()}${entry.type.slice(1)} · ${blockLink(app, book, entry, pageLabel(entry))}`;
  return [`> [!${entry.type}] ${title}`, ...quoteLines(entry.exact)].join("\n");
}
