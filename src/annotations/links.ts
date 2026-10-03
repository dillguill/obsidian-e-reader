// Links to one highlight: the reader links (`obsidian://e-reader?id=…`) and
// the wiki links and embeds a reader copies into their own notes.
//
// A reader link names only the entry id, so finding the book means finding
// the note that holds that id: a book note with a `^id` block, or a highlight
// note whose anchor property names it.

import type { App, TFile } from "obsidian";
import type { HighlightSettings } from "../settings/settings-model";
import type { Entry } from "./entry";
import { anchorIdOf, bookOf } from "./highlight-notes";

/** The book note holding the entry `id`, wherever the entry is written. */
export function findBookForEntry(app: App, id: string, settings: HighlightSettings): TFile | null {
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    if (cache.blocks?.[id]) return file;
    if (anchorIdOf(cache.frontmatter, settings.properties) === id) return bookOf(app, file, settings.properties.book);
  }
  return null;
}

/** The highlight a highlight note holds and the book it belongs to, or null for any other file. */
export function highlightOfNote(app: App, file: TFile, settings: HighlightSettings): { id: string; book: TFile } | null {
  const id = anchorIdOf(app.metadataCache.getFileCache(file)?.frontmatter, settings.properties);
  if (id === null) return null;
  const book = bookOf(app, file, settings.properties.book);
  return book ? { id, book } : null;
}

/**
 * A link to the highlight for pasting into another note: the block in the
 * book note, or the highlight's own note. With `embed`, the same as an embed,
 * which shows the quote inline and still links back to where it lives.
 */
export function entryLink(app: App, book: TFile, entry: Entry, embed: boolean): string {
  const own = entry.source ? app.vault.getAbstractFileByPath(entry.source) : null;
  const target = own && "extension" in own ? (own as TFile) : book;
  const subpath = target === book ? `#^${entry.id}` : "";
  const link = app.fileManager.generateMarkdownLink(target, "", subpath);
  return embed ? `!${link}` : link;
}
