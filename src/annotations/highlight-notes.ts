// Highlights kept as notes of their own (the "notes" highlight mode).
//
// A highlight note is tied to its book by one property, a link to the book
// note, under the name the reader chose (`book` by default). Everything the
// plugin needs to find the passage again sits in properties too: the type,
// and an `anchor` property holding the entry id, the text either side and
// the position as JSON. The body is the reader's: the quote, the link back
// into the book, then whatever they write underneath. The quote stays the
// authority on what was highlighted, so editing it edits the anchor, exactly
// as it does for an entry in the book note.
//
// Notes written by 0.3.7 betas kept the anchor in a hidden `%%…%%` line of a
// quote block in the body instead. Those still parse, and are rewritten in
// the current shape the next time they change.
//
// The book note carries nothing of this except, once, an embedded Bases view
// (`![[Highlights.base#This book]]`) listing the notes whose book property
// links to it, so there is one place highlights live and the book note never
// goes stale.
//
// Notes are found through `metadataCache.resolvedLinks`, which already knows
// every note linking to the book, so listing a book's highlights does not
// scan the vault.

import type { App, TFile } from "obsidian";
import { parseLocator, serializeLocator } from "../core/locator";
import type { AnchorRecord } from "../core/types";
import { joinPath, safeFileName } from "../import/plan";
import type { HighlightNoteProperties, HighlightSettings } from "../settings/settings-model";
import { type Entry, isJumpLink, isValidEntryId, parseEntry, quoteLines } from "./entry";

/** A short name for a highlight note: the opening words of its quote. */
const NAME_WORDS = 8;

/** The Bases file listing highlight notes, kept in the highlight folder. */
export const HIGHLIGHTS_BASE_NAME = "Highlights.base";
/** The view of that base a book note embeds: only that book's highlights. */
export const THIS_BOOK_VIEW = "This book";

export interface NoteEntry {
  entry: Entry;
  file: TFile;
}

/** Extra details a new highlight note records as properties. */
export interface NoteDetails {
  page?: number;
  section?: string;
}

/**
 * The link that opens the reader at an entry, labelled with its page where
 * there is one. It names only the entry: the handler finds which book holds
 * it, so the link keeps working when the book note is renamed or moved, or
 * the highlight moves between the book note and a note of its own.
 */
export function jumpLink(app: App, entry: Entry): string {
  const hint = entry.anchor.hint;
  const label = hint?.kind === "pdf" ? `p. ${hint.page}` : "Open in book";
  const params = new URLSearchParams({ vault: app.vault.getName(), id: entry.id });
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

/** The anchor property's value: everything but the type and creation time, which have properties of their own. */
export function encodeAnchorProperty(anchor: AnchorRecord): string {
  const json: AnchorProperty = { id: anchor.id };
  if (anchor.prefix !== undefined && anchor.prefix !== "") json.prefix = anchor.prefix;
  if (anchor.suffix !== undefined && anchor.suffix !== "") json.suffix = anchor.suffix;
  if (anchor.hint !== undefined) json.hint = serializeLocator(anchor.hint);
  return JSON.stringify(json);
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

/** The entry id a note's properties name, without reading its body. Used to find a highlight from a link. */
export function anchorIdOf(frontmatter: Record<string, unknown> | undefined, properties: HighlightNoteProperties): string | null {
  return decodeAnchorProperty(frontmatter?.[properties.anchor], "")?.id ?? null;
}

function stringProperty(frontmatter: Record<string, unknown> | undefined, name: string): string | null {
  const value = frontmatter?.[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The entry a highlight note holds, or null when it does not hold one. */
export function parseNote(text: string, frontmatter: Record<string, unknown> | undefined, settings: HighlightSettings): Entry | null {
  const names = settings.properties;
  const split = splitBody(bodyOf(text));
  const type = stringProperty(frontmatter, names.type);
  const anchor = decodeAnchorProperty(frontmatter?.[names.anchor], stringProperty(frontmatter, names.created) ?? "");
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

function noteBody(app: App, entry: Entry, settings: HighlightSettings): string {
  const parts: string[] = [];
  if (entry.exact !== "") parts.push(quoteLines(entry.exact).join("\n"));
  if (settings.pageLinks) parts.push(jumpLink(app, entry));
  if (entry.comment !== "") parts.push(entry.comment);
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

/** Where a book's highlight notes go. */
export function highlightFolder(book: TFile, settings: HighlightSettings): string {
  return settings.subfolderPerBook ? joinPath(settings.folder, safeFileName(book.basename)) : settings.folder;
}

function availablePath(app: App, path: string, extension = ".md"): string {
  const stem = path.slice(0, -extension.length);
  let candidate = path;
  for (let n = 1; app.vault.getAbstractFileByPath(candidate); n++) candidate = `${stem} ${n}${extension}`;
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

function writeProperties(
  app: App,
  book: TFile,
  file: TFile,
  entry: Entry,
  details: NoteDetails,
  settings: HighlightSettings,
): (fm: Record<string, unknown>) => void {
  const names = settings.properties;
  return (fm) => {
    fm[names.book] = `[[${app.metadataCache.fileToLinktext(book, file.path, true)}]]`;
    fm[names.type] = entry.type;
    if (details.page !== undefined) fm[names.page] = details.page;
    if (details.section !== undefined && details.section !== "") fm[names.section] = details.section;
    if (entry.anchor.created !== "") fm[names.created] = entry.anchor.created;
    fm[names.anchor] = encodeAnchorProperty(entry.anchor);
  };
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
  const file = await app.vault.create(availablePath(app, joinPath(folder, `${name}.md`)), noteBody(app, entry, settings));
  await app.fileManager.processFrontMatter(file, writeProperties(app, book, file, entry, details, settings));
  return file;
}

/**
 * Rewrites a highlight note's body (quote, link, comment) and its type and
 * anchor properties, leaving any other properties alone. A note in the old
 * shape is brought up to date on the way.
 */
export async function updateHighlightNote(app: App, item: NoteEntry, entry: Entry, settings: HighlightSettings): Promise<void> {
  await app.vault.process(item.file, (text) => {
    const head = text.slice(0, text.length - bodyOf(text).length);
    return head + noteBody(app, entry, settings);
  });
  const names = settings.properties;
  await app.fileManager.processFrontMatter(item.file, (fm: Record<string, unknown>) => {
    fm[names.type] = entry.type;
    fm[names.anchor] = encodeAnchorProperty(entry.anchor);
    if (fm[names.created] === undefined && entry.anchor.created !== "") fm[names.created] = entry.anchor.created;
  });
}

/** A property for Bases' `note.x` shorthand, or null when the name needs quoting. */
function dotted(name: string): string | null {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `note.${name}` : null;
}

/** The `.base` file every book note embeds, written once and then left to the reader to adjust. */
export function highlightsBaseSource(settings: HighlightSettings): string {
  const names = settings.properties;
  const quoted = (expression: string): string => `'${expression.replace(/'/g, "''")}'`;
  const order = ["file.name", dotted(names.type), dotted(names.page), dotted(names.section)].filter(
    (value): value is string => value !== null,
  );
  const orderYaml = order.map((value) => `      - ${value}`).join("\n");
  const groupBy = dotted(names.book);
  return [
    "filters:",
    "  and:",
    `    - ${quoted(`file.hasProperty(${JSON.stringify(names.anchor)})`)}`,
    "views:",
    "  - type: table",
    `    name: ${THIS_BOOK_VIEW}`,
    "    filters:",
    "      and:",
    `        - ${quoted(`note[${JSON.stringify(names.book)}] == this`)}`,
    "    order:",
    orderYaml,
    "  - type: table",
    "    name: All highlights",
    ...(groupBy === null ? [] : ["    groupBy:", `      property: ${groupBy}`, "      direction: ASC"]),
    "    order:",
    orderYaml,
    "",
  ].join("\n");
}

/** The highlights base, created in the highlight folder when it is not there yet. */
export async function ensureHighlightsBase(app: App, settings: HighlightSettings): Promise<TFile> {
  const path = joinPath(settings.folder, HIGHLIGHTS_BASE_NAME);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing && "extension" in existing) return existing as TFile;
  await ensureFolder(app, settings.folder);
  return app.vault.create(path, highlightsBaseSource(settings));
}

const EMBED_RE = /\n*(?:## Highlights\n)?!\[\[[^\]\n]*Highlights\.base#This book\]\]\n?/g;

/** Whether the book note already embeds the highlights base. */
function hasEmbed(text: string): boolean {
  return /!\[\[[^\]\n]*Highlights\.base#This book\]\]/.test(text);
}

/** Embeds the book's highlights view at the end of its note, once. */
export async function ensureEmbed(app: App, book: TFile, settings: HighlightSettings): Promise<void> {
  const base = await ensureHighlightsBase(app, settings);
  const link = app.metadataCache.fileToLinktext(base, book.path, false);
  await app.vault.process(book, (text) => {
    if (hasEmbed(text)) return text;
    const before = text.replace(/\s+$/, "");
    return `${before}${before === "" ? "" : "\n\n"}## Highlights\n![[${link}#${THIS_BOOK_VIEW}]]\n`;
  });
}

/** `text` without the embedded highlights view, and the heading this plugin put above it. */
export function withoutEmbed(text: string): string {
  if (!hasEmbed(text)) return text;
  const stripped = text.replace(EMBED_RE, "\n");
  return stripped.replace(/\s+$/, "") === "" ? "" : `${stripped.replace(/\s+$/, "")}\n`;
}
