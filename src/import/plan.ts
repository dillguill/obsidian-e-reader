// Pure decisions an import makes before touching the vault: what files are
// called, what the note's properties are, and whether the book is already
// there. Kept free of Obsidian so it is covered without a vault.

import type { BookMetadata } from "./metadata";

/** Characters no file name may carry on at least one platform Obsidian runs on, plus Obsidian's own link syntax. */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;
/** Long enough for a real title, short enough for every filesystem's path limit with folders in front. */
const MAX_NAME_LENGTH = 120;

/** A file name, without extension, made from a title. */
export function safeFileName(title: string): string {
  const cleaned = title
    .replace(UNSAFE, " ")
    .replace(/\s+/g, " ")
    .trim()
    // A leading dot hides a file; trailing dots and spaces break on Windows.
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  const clipped = cleaned.length > MAX_NAME_LENGTH ? cleaned.slice(0, MAX_NAME_LENGTH).trimEnd() : cleaned;
  return clipped === "" ? "Untitled book" : clipped;
}

/** Lower-cased, accents and punctuation dropped, a leading article removed: for telling two titles apart. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

/** Identity for the duplicate check: the ISBN when there is one, else title and first author. */
export function duplicateKeys(meta: Pick<BookMetadata, "title" | "authors" | "isbn">): string[] {
  const keys: string[] = [];
  if (meta.isbn) keys.push(`isbn:${meta.isbn}`);
  const title = normalizeForMatch(meta.title);
  if (title !== "") keys.push(`book:${title}|${normalizeForMatch(meta.authors[0] ?? "")}`);
  return keys;
}

/** The names the note's properties are written under; the configurable ones come from settings. */
export interface NoteProperties {
  marker: string;
  markerValue: string;
  cover: string;
  attachments: string;
}

/**
 * The new note's frontmatter. Links are passed in already formatted, since
 * only Obsidian knows how this vault writes them. Empty fields are left out
 * rather than written blank.
 */
export function buildFrontmatter(
  meta: BookMetadata,
  names: NoteProperties,
  links: { book: string | null; cover: string | null },
): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  if (names.marker.trim() !== "") fm[names.marker] = names.markerValue.trim() === "" ? "book" : names.markerValue;
  fm["title"] = meta.title;
  if (meta.authors.length > 0) fm["author"] = [...meta.authors];
  if (links.cover && names.cover.trim() !== "") fm[names.cover] = links.cover;
  // A wishlist book has no file yet; its attachments arrive when one is added.
  if (links.book !== null) fm[names.attachments] = [links.book];
  if (meta.published) fm["published"] = meta.published;
  if (meta.publisher) fm["publisher"] = meta.publisher;
  if (meta.language) fm["language"] = meta.language;
  if (meta.isbn) fm["isbn"] = meta.isbn;
  if (meta.pages) fm["pages"] = meta.pages;
  if (meta.subjects.length > 0) fm["topics"] = [...meta.subjects];
  if (meta.description) fm["description"] = meta.description;
  return fm;
}

/** Joins a folder and a file name, treating an empty folder as the vault root. */
export function joinPath(folder: string, name: string): string {
  const trimmed = folder.replace(/^\/+|\/+$/g, "").trim();
  return trimmed === "" ? name : `${trimmed}/${name}`;
}

/** True when `path` sits inside `folder` (at any depth). An empty folder contains nothing. */
export function isInFolder(path: string, folder: string): boolean {
  const trimmed = folder.replace(/^\/+|\/+$/g, "").trim();
  return trimmed !== "" && path.startsWith(`${trimmed}/`);
}
