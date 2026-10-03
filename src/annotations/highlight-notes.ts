// Highlight notes.
//
// Highlights live in the book note; that is the one place they are stored.
// A highlight can be exported as a note of its own (export-note.ts); that
// note is a starting point, not a second store, and is never read back as a
// highlight.
//
// Betas of 0.3.7 and 0.4.0 could instead store a highlight only in a note of
// its own, with its anchor in a hidden `%%…%%` line (0.3.7) or an `anchor`
// property (0.4.0-beta.1). Those notes are still read here, so they can be
// folded back into their book note (store.ts, foldHighlightNotes).

import type { App, TFile } from "obsidian";
import { parseLocator, serializeLocator } from "../core/locator";
import type { AnchorRecord } from "../core/types";
import { joinPath, safeFileName } from "../import/plan";
import type { HighlightSettings } from "../settings/settings-model";
import { type Entry, isJumpLink, isValidEntryId, parseEntry } from "./entry";

/** Where 0.4.0-beta.1 kept a highlight note's anchor. */
const LEGACY_ANCHOR_PROPERTY = "anchor";
/** Where 0.4.0-beta.1 kept a highlight note's type when nothing else names it. */
const LEGACY_TYPE_PROPERTY = "highlight";

export interface NoteEntry {
  entry: Entry;
  file: TFile;
}

/** Extra details recorded with a new highlight. */
export interface NoteDetails {
  page?: number;
  section?: string;
}

/** The book's title: its `title` property, or the note's name. */
export function bookTitle(app: App, book: TFile): string {
  const title = app.metadataCache.getFileCache(book)?.frontmatter?.["title"];
  return typeof title === "string" && title.trim() !== "" ? title.trim() : book.basename;
}

/** The reader link to an entry. It names only the entry, so it survives the book note being renamed or moved. */
export function readerUrl(app: App, entry: Entry): string {
  const params = new URLSearchParams({ vault: app.vault.getName(), id: entry.id });
  // URLSearchParams writes spaces as `+`, which Obsidian's URI handler does not decode.
  return `obsidian://e-reader?${params.toString().replace(/\+/g, "%20")}`;
}

/** Where the passage is: book title, chapter or section, and page, as far as they are known. */
export function sourceLabel(app: App, book: TFile, entry: Entry): string {
  const hint = entry.anchor.hint;
  const parts = [bookTitle(app, book), entry.anchor.section, hint?.kind === "pdf" ? `p. ${hint.page}` : undefined];
  // `[` and `]` would end the link text early.
  return parts
    .filter((part): part is string => part !== undefined && part !== "")
    .join(", ")
    .replace(/[[\]]/g, "");
}

/** The line under a quote that says where it is from and opens the reader there: `– [Dune, Book One, p. 35](obsidian://…)`. */
export function attribution(app: App, book: TFile, entry: Entry): string {
  return `– [${sourceLabel(app, book, entry)}](${readerUrl(app, entry)})`;
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

/** The book note a file's book property links to, if any. */
export function bookOf(app: App, file: TFile, property: string): TFile | null {
  const links = app.metadataCache.getFileCache(file)?.frontmatterLinks ?? [];
  for (const link of links) {
    if (link.key !== property && !link.key.startsWith(`${property}.`)) continue;
    const target = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
    if (target) return target;
  }
  return null;
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

/** Every note of `book` that stores a highlight rather than embedding one (beta formats), oldest first. */
export async function listHighlightNotes(app: App, book: TFile, settings: HighlightSettings): Promise<NoteEntry[]> {
  const found: NoteEntry[] = [];
  for (const [path, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
    if (!targets[book.path] || path === book.path) continue;
    const file = app.vault.getAbstractFileByPath(path);
    if (!file || !("extension" in file) || (file as TFile).extension !== "md") continue;
    const note = file as TFile;
    if (!linksToBook(app, note, book, settings.properties.book)) continue;
    const parsed = parseNote(await app.vault.cachedRead(note), app.metadataCache.getFileCache(note)?.frontmatter, settings);
    if (parsed) found.push({ entry: { ...parsed, source: note.path }, file: note });
  }
  return found.sort((a, b) => a.entry.anchor.created.localeCompare(b.entry.anchor.created));
}

interface AnchorProperty {
  id: string;
  prefix?: string;
  suffix?: string;
  hint?: string;
}

/** Reads an anchor property back. Null when it is missing or does not carry a valid id. */
export function decodeAnchorProperty(value: unknown, created: string): AnchorRecord | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || !isValidEntryId(id)) return null;
  const anchor: AnchorRecord = { id, created };
  if (typeof record["prefix"] === "string") anchor.prefix = record["prefix"];
  if (typeof record["suffix"] === "string") anchor.suffix = record["suffix"];
  if (typeof record["hint"] === "string") {
    const hint = parseLocator(record["hint"]);
    if (hint !== null) anchor.hint = hint;
  }
  return anchor;
}

/** The entry id a 0.4.0-beta.1 highlight note's properties name. */
export function anchorIdOf(frontmatter: Record<string, unknown> | undefined): string | null {
  return decodeAnchorProperty(frontmatter?.[LEGACY_ANCHOR_PROPERTY], "")?.id ?? null;
}

function stringProperty(frontmatter: Record<string, unknown> | undefined, name: string): string | null {
  const value = frontmatter?.[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The entry a beta highlight note stores, or null when it stores none (an exported note embeds its highlight instead). */
export function parseNote(text: string, frontmatter: Record<string, unknown> | undefined, settings: HighlightSettings): Entry | null {
  const names = settings.properties;
  const split = splitBody(bodyOf(text));
  const type = stringProperty(frontmatter, names.type) ?? stringProperty(frontmatter, LEGACY_TYPE_PROPERTY);
  const anchor = decodeAnchorProperty(frontmatter?.[LEGACY_ANCHOR_PROPERTY], stringProperty(frontmatter, names.created) ?? "");
  if (anchor) {
    if (type === null) return null;
    const quote = split
      ? split.block
          .split("\n")
          .map((line) => line.replace(/^\s*>\s?/, "").trim())
          .filter((line) => line !== "" && !isJumpLink(line))
          .join(" ")
      : "";
    const rest = split ? split.rest : bodyOf(text).trim();
    const comment = rest
      .split("\n")
      .filter((line, i) => !(i === 0 && isJumpLink(line)))
      .join("\n")
      .trim();
    return { id: anchor.id, type, exact: quote, comment, anchor, format: "note" };
  }
  // 0.3.7 betas: the anchor in a `%%…%%` line inside the quote block.
  if (!split) return null;
  const parsed = parseEntry(split.block);
  if (!parsed.ok || !isValidEntryId(parsed.entry.id)) return null;
  return { ...parsed.entry, type: type ?? parsed.entry.type, comment: split.rest, format: "note" };
}

/** Where a book's highlight notes go. */
export function highlightFolder(book: TFile, settings: HighlightSettings): string {
  return settings.subfolderPerBook ? joinPath(settings.folder, safeFileName(book.basename)) : settings.folder;
}

export function availablePath(app: App, path: string, extension = ".md"): string {
  const stem = path.slice(0, -extension.length);
  let candidate = path;
  for (let n = 1; app.vault.getAbstractFileByPath(candidate); n++) candidate = `${stem} ${n}${extension}`;
  return candidate;
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
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

/** The embedded highlights view 0.4.0-beta.1 added to book notes. */
const EMBED_RE = /\n*(?:## Highlights\n)?!\[\[[^\]\n]*Highlights\.base#This book\]\]\n?/g;

/** `text` without the 0.4.0-beta.1 embedded highlights view and the heading above it. */
export function withoutEmbed(text: string): string {
  if (!/!\[\[[^\]\n]*Highlights\.base#This book\]\]/.test(text)) return text;
  const stripped = text.replace(EMBED_RE, "\n").replace(/\s+$/, "");
  return stripped === "" ? "" : `${stripped}\n`;
}
