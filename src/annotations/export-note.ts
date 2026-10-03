// Exporting a highlight as a note of its own.
//
// The body comes from a template: a note the reader picks, or the built-in
// layout, which matches Copy as quote (the quote with its source line and a
// link back to the highlight in the book note, then the comment). The
// placeholders are filled in and blank lines left by empty ones are closed
// up. Properties (book, type, chapter, page, created, under names the reader
// chose) are added on top of any the template itself has, so Bases can list
// and group exported highlights.
//
// The export is a copy for the reader to write around. Nothing reads it back
// as a highlight; the book note stays the one place highlights are stored.

import { type App, TFile } from "obsidian";
import { joinPath, safeFileName } from "../import/plan";
import type { HighlightSettings } from "../settings/settings-model";
import type { Entry } from "./entry";
import { availablePath, bookTitle, ensureFolder, highlightFolder, sourceLabel } from "./highlight-notes";
import { noteLink, quoteBlock } from "./links";

/** The layout used when no template is set. */
export const DEFAULT_EXPORT_TEMPLATE = "{{highlight}}\n\n{{comment}}\n";

/** Words of the quote that go into an exported note's name. */
const NAME_WORDS = 8;

/** The placeholders a template can use, and their values for `entry`. */
export function templateValues(app: App, book: TFile, entry: Entry, sourcePath: string): Record<string, string> {
  const hint = entry.anchor.hint;
  return {
    highlight: quoteBlock(app, book, entry, false, sourcePath),
    quote: entry.exact,
    comment: entry.comment,
    link: noteLink(app, book, entry, sourcePath),
    source: sourceLabel(app, book, entry),
    book: bookTitle(app, book),
    chapter: entry.anchor.section ?? "",
    page: hint?.kind === "pdf" ? String(hint.page) : "",
    type: entry.type,
    created: entry.anchor.created.slice(0, 10),
  };
}

/** `template` with every `{{name}}` replaced; unknown names are left as they are. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const filled = template.replace(/\{\{\s*([a-z]+)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
  return `${filled.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "")}\n`;
}

/** An exported note's name: the quote's opening words, or the book and id for a highlight with no text. */
export function exportName(book: TFile, entry: Entry): string {
  const words = entry.exact.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return safeFileName(`${book.basename} ${entry.id}`);
  return safeFileName(words.slice(0, NAME_WORDS).join(" ") + (words.length > NAME_WORDS ? "…" : ""));
}

async function readTemplate(app: App, settings: HighlightSettings): Promise<string> {
  const path = settings.template.trim();
  if (path === "") return DEFAULT_EXPORT_TEMPLATE;
  const file = app.vault.getAbstractFileByPath(path) ?? app.vault.getAbstractFileByPath(`${path}.md`);
  if (!(file instanceof TFile)) throw new Error(`the export template “${path}” could not be found`);
  return app.vault.cachedRead(file);
}

/** Exports a book-note highlight as a note of its own. Returns the new note. */
export async function exportHighlightNote(app: App, book: TFile, entry: Entry, settings: HighlightSettings): Promise<TFile> {
  const template = await readTemplate(app, settings);
  const folder = highlightFolder(book, settings);
  await ensureFolder(app, folder);
  const path = availablePath(app, joinPath(folder, `${exportName(book, entry)}.md`));
  const file = await app.vault.create(path, renderTemplate(template, templateValues(app, book, entry, path)));
  const names = settings.properties;
  const hint = entry.anchor.hint;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm[names.book] = `[[${app.metadataCache.fileToLinktext(book, file.path, true)}]]`;
    fm[names.type] = entry.type;
    if (entry.anchor.section) fm[names.section] = entry.anchor.section;
    if (hint?.kind === "pdf") fm[names.page] = hint.page;
    fm[names.created] = entry.anchor.created !== "" ? entry.anchor.created : new Date().toISOString();
  });
  return file;
}
