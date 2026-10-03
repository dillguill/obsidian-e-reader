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

/** What the duplicate check compares: an ISBN, a title, and the first author's surname. */
export interface BookIdentity {
  isbn: string | null;
  title: string;
  surname: string;
}

/** An ISBN as 13 digits, so the hyphenated and the 10-digit forms of one ISBN compare equal. */
export function normalizeIsbn(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.toUpperCase().replace(/[^0-9X]/g, "");
  if (digits.length === 13 && /^\d{13}$/.test(digits)) return digits;
  if (digits.length !== 10 || !/^\d{9}[\dX]$/.test(digits)) return null;
  const core = `978${digits.slice(0, 9)}`;
  const sum = [...core].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

/**
 * A title without its subtitle or a bracketed note, so "Dune: Deluxe
 * Edition" and "Dune (Frank Herbert)" are both Dune.
 */
export function mainTitle(title: string): string {
  const cut = title.split(/\s*[:(\[]|\s+[-–—]\s+/)[0] ?? title;
  const main = normalizeForMatch(cut);
  return main === "" ? normalizeForMatch(title) : main;
}

/** The surname: "Herbert" from both "Frank Herbert" and "Herbert, Frank"; "Austen" from "J. Austen". */
export function surnameOf(author: string): string {
  const name = author.replace(/^\[\[|\]\]$/g, "").trim();
  const comma = name.indexOf(",");
  const part = comma > 0 ? name.slice(0, comma) : (name.split(/\s+/).pop() ?? "");
  return normalizeForMatch(part);
}

export function bookIdentity(meta: Pick<BookMetadata, "title" | "authors" | "isbn">): BookIdentity {
  return { isbn: normalizeIsbn(meta.isbn), title: mainTitle(meta.title), surname: surnameOf(meta.authors[0] ?? "") };
}

/**
 * The same book: one ISBN, or the same title by the same author. A missing
 * author matches any, since notes made by hand often leave it out; a
 * differing ISBN does not rule a match out, since an ebook and a print copy
 * of one book carry different ones.
 */
export function sameBook(a: BookIdentity, b: BookIdentity): boolean {
  if (a.isbn !== null && a.isbn === b.isbn) return true;
  if (a.title === "" || a.title !== b.title) return false;
  return a.surname === "" || b.surname === "" || a.surname === b.surname;
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

/**
 * The books that appear more than once, as groups of two or more. Only books
 * sharing an ISBN or a title are compared, so a large library stays quick.
 */
export function groupDuplicates<T>(items: readonly T[], identity: (item: T) => BookIdentity): T[][] {
  const ids = items.map(identity);
  const parent = items.map((_, index) => index);
  const root = (index: number): number => {
    let at = index;
    while (parent[at] !== at) at = parent[at] = parent[parent[at] as number] as number;
    return at;
  };
  const join = (a: number, b: number): void => {
    parent[root(a)] = root(b);
  };
  const byIsbn = new Map<string, number>();
  const byTitle = new Map<string, number[]>();
  ids.forEach((id, index) => {
    if (id.isbn !== null) {
      const seen = byIsbn.get(id.isbn);
      if (seen === undefined) byIsbn.set(id.isbn, index);
      else join(index, seen);
    }
    if (id.title === "") return;
    const same = byTitle.get(id.title) ?? [];
    for (const other of same) if (sameBook(id, ids[other] as BookIdentity)) join(index, other);
    same.push(index);
    byTitle.set(id.title, same);
  });
  const groups = new Map<number, T[]>();
  items.forEach((item, index) => {
    const key = root(index);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

/** One detail a lookup can add to a note, under the property buildFrontmatter writes it to. */
export interface DetailRow {
  property: string;
  label: string;
  value: string | number | string[];
  /** How the value reads in a list, cut short when long. */
  display: string;
}

const MAX_DETAIL_DISPLAY = 160;

function shown(value: string | number | string[]): string {
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return text.length > MAX_DETAIL_DISPLAY ? `${text.slice(0, MAX_DETAIL_DISPLAY - 1).trimEnd()}…` : text;
}

/** The details `meta` carries beyond its title, in the order a note lists them. */
export function detailRows(meta: BookMetadata): DetailRow[] {
  const rows: DetailRow[] = [];
  const add = (property: string, label: string, value: string | number | string[] | undefined): void => {
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
    rows.push({ property, label, value, display: shown(value) });
  };
  add("author", "Author", meta.authors);
  add("published", "Published", meta.published);
  add("publisher", "Publisher", meta.publisher);
  add("language", "Language", meta.language);
  add("isbn", "ISBN", meta.isbn);
  add("pages", "Pages", meta.pages);
  add("topics", "Topics", meta.subjects);
  add("description", "Description", meta.description);
  return rows;
}

/** `meta` keeping only the details whose property is in `keep`. */
export function keepDetails(meta: BookMetadata, keep: ReadonlySet<string>): BookMetadata {
  const has = (property: string): boolean => keep.has(property);
  return {
    title: meta.title,
    authors: has("author") ? meta.authors : [],
    subjects: has("topics") ? meta.subjects : [],
    ...(has("published") && meta.published !== undefined ? { published: meta.published } : {}),
    ...(has("publisher") && meta.publisher !== undefined ? { publisher: meta.publisher } : {}),
    ...(has("language") && meta.language !== undefined ? { language: meta.language } : {}),
    ...(has("isbn") && meta.isbn !== undefined ? { isbn: meta.isbn } : {}),
    ...(has("pages") && meta.pages !== undefined ? { pages: meta.pages } : {}),
    ...(has("description") && meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.cover !== undefined ? { cover: meta.cover } : {}),
  };
}
