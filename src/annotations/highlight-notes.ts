// Highlights kept as notes of their own (the "note" highlight format).
//
// A highlight note is tied to its book by one property, a link to the book
// note, under the name the reader chose (`book` by default). Its body is the
// same quote block an in-note entry uses (entry.ts, quote form), so the quote
// stays the anchor and the hidden `%%…%%` record carries the rest; whatever
// follows the block is the reader's comment. The type lives in a property
// too, so Bases can filter and group highlights, and that property wins over
// the copy in the anchor record when the two disagree.
//
// Notes are found through `metadataCache.resolvedLinks`, which already knows
// every note linking to the book, so listing a book's highlights does not
// scan the vault.

import type { App, TFile } from "obsidian";
import { joinPath, safeFileName } from "../import/plan";
import type { HighlightSettings } from "../settings/settings-model";
import { type Entry, isValidEntryId, parseEntry, serializeEntry } from "./entry";

/** A short name for a highlight note: the opening words of its quote. */
const NAME_WORDS = 8;

export interface NoteEntry {
  entry: Entry;
  file: TFile;
}

/** Extra details a new highlight note records as properties. */
export interface NoteDetails {
  page?: number;
  section?: string;
}

/** The link that opens the reader at an entry, labelled with its page where there is one. */
export function jumpLink(app: App, book: TFile, entry: Entry): string {
  const hint = entry.anchor.hint;
  const label = hint?.kind === "pdf" ? `p. ${hint.page}` : "Open in book";
  const params = new URLSearchParams({ vault: app.vault.getName(), file: book.path, id: entry.id });
  // URLSearchParams writes spaces as `+`, which Obsidian's URI handler does not decode.
  return `[${label}](obsidian://e-reader?${params.toString().replace(/\+/g, "%20")})`;
}

function bodyOf(text: string): string {
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

/** Splits a note body into its first blockquote and whatever follows it. */
function splitBody(body: string): { block: string; rest: string } | null {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => /^\s*>/.test(line));
  if (start === -1) return null;
  let end = start;
  while (end < lines.length && /^\s*>/.test(lines[end] as string)) end++;
  return { block: lines.slice(start, end).join("\n"), rest: lines.slice(end).join("\n").trim() };
}

/** Whether `file`'s book property links to `book`: whether it is, or could be, one of that book's highlight notes. */
export function linksToBook(app: App, file: TFile, book: TFile, property: string): boolean {
  const links = app.metadataCache.getFileCache(file)?.frontmatterLinks ?? [];
  return links.some(
    (link) =>
      (link.key === property || link.key.startsWith(`${property}.`)) &&
      app.metadataCache.getFirstLinkpathDest(link.link, file.path)?.path === book.path,
  );
}

/** Every highlight note of `book`, in the order they were created. */
export async function listHighlightNotes(app: App, book: TFile, settings: HighlightSettings): Promise<NoteEntry[]> {
  const found: NoteEntry[] = [];
  for (const [path, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!targets[book.path] || path === book.path) continue;
    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !("extension" in file) || (file as TFile).extension !== "md") continue;
    const note = file as TFile;
    if (!linksToBook(app, note, book, settings.properties.book)) continue;
    const parsed = parseNote(await app.vault.cachedRead(note), app.metadataCache.getFileCache(note)?.frontmatter, settings);
    if (parsed) found.push({ entry: parsed, file: note });
  }
  return found.sort((a, b) => a.entry.anchor.created.localeCompare(b.entry.anchor.created));
}

/** The entry a highlight note holds, or null when it does not hold one. */
export function parseNote(text: string, frontmatter: Record<string, unknown> | undefined, settings: HighlightSettings): Entry | null {
  const split = splitBody(bodyOf(text));
  if (!split) return null;
  const parsed = parseEntry(split.block);
  if (!parsed.ok || !isValidEntryId(parsed.entry.id)) return null;
  const type = frontmatter?.[settings.properties.type];
  return {
    ...parsed.entry,
    type: typeof type === "string" && type.trim() !== "" ? type.trim() : parsed.entry.type,
    comment: split.rest,
    format: "note",
  };
}

function noteBody(entry: Entry, link: string): string {
  const block = serializeEntry({ ...entry, format: "quote", comment: "" }, link).replace(/\n\n\^[^\n]*\n$/, "");
  return entry.comment === "" ? `${block}\n` : `${block}\n\n${entry.comment}\n`;
}

/** Where a book's highlight notes go. */
export function highlightFolder(book: TFile, settings: HighlightSettings): string {
  return settings.subfolderPerBook ? joinPath(settings.folder, safeFileName(book.basename)) : settings.folder;
}

function availablePath(app: App, path: string): string {
  const stem = path.slice(0, -".md".length);
  let candidate = path;
  for (let n = 1; app.vault.getAbstractFileByPath(candidate); n++) candidate = `${stem} ${n}.md`;
  return candidate;
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const parts = folder.split("/").filter((part) => part !== "");
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    if (app.vault.getAbstractFileByPath(path)) continue;
    try {
      await app.vault.createFolder(path);
    } catch (error) {
      if (!(await app.vault.adapter.exists(path))) throw error;
    }
  }
}

export async function createHighlightNote(
  app: App,
  book: TFile,
  entry: Entry,
  details: NoteDetails,
  settings: HighlightSettings,
): Promise<TFile> {
  const folder = highlightFolder(book, settings);
  const words = entry.exact.split(/\s+/).slice(0, NAME_WORDS).join(" ");
  const name = words === "" ? `${book.basename} ${entry.id}` : safeFileName(words);
  await ensureFolder(app, folder);
  const file = await app.vault.create(availablePath(app, joinPath(folder, `${name}.md`)), noteBody(entry, jumpLink(app, book, entry)));
  const names = settings.properties;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm[names.book] = `[[${app.metadataCache.fileToLinktext(book, file.path, true)}]]`;
    fm[names.type] = entry.type;
    if (details.page !== undefined) fm[names.page] = details.page;
    if (details.section !== undefined && details.section !== "") fm[names.section] = details.section;
    fm[names.created] = entry.anchor.created;
  });
  return file;
}

/** Rewrites a highlight note's quote block and comment, and its type property, leaving any other properties alone. */
export async function updateHighlightNote(app: App, book: TFile, item: NoteEntry, entry: Entry, settings: HighlightSettings): Promise<void> {
  await app.vault.process(item.file, (text) => {
    const head = text.slice(0, text.length - bodyOf(text).length);
    return head + noteBody(entry, jumpLink(app, book, entry));
  });
  if (entry.type !== item.entry.type) {
    await app.fileManager.processFrontMatter(item.file, (fm: Record<string, unknown>) => {
      fm[settings.properties.type] = entry.type;
    });
  }
}

/** The link list the book note's region shows for its highlight notes. */
export function linkList(app: App, book: TFile, notes: readonly NoteEntry[]): string {
  return notes
    .map(({ entry, file }) => {
      const words = entry.exact.split(/\s+/).slice(0, NAME_WORDS).join(" ");
      const label = (words === "" ? file.basename : `“${words}${entry.exact.split(/\s+/).length > NAME_WORDS ? "…" : ""}”`).replace(/[|\]]/g, " ");
      return `- [[${app.metadataCache.fileToLinktext(file, book.path, true)}|${label}]] · ${jumpLink(app, book, entry)}`;
    })
    .join("\n");
}
