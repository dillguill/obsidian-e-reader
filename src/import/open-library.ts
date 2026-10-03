// The optional Open Library lookup: fills fields a file did not carry.
//
// It only ever fills gaps (see fillGaps), and a result is only trusted when
// its title matches the book's, so a loose search cannot rename a book or
// hand it someone else's cover.

import { requestUrl } from "obsidian";
import type { BookMetadata } from "./metadata";
import { normalizeForMatch } from "./plan";

const SEARCH_URL = "https://openlibrary.org/search.json";
const FIELDS = "title,author_name,isbn,number_of_pages_median,subject,first_publish_year,publisher,cover_i";
/** Subjects on Open Library run to dozens; a handful is what a note can use. */
const MAX_SUBJECTS = 5;

export function searchUrl(meta: Pick<BookMetadata, "title" | "authors" | "isbn">): string {
  const params = new URLSearchParams({ fields: FIELDS, limit: "1" });
  if (meta.isbn) params.set("isbn", meta.isbn);
  else {
    params.set("title", meta.title);
    const author = meta.authors[0];
    if (author) params.set("author", author);
  }
  return `${SEARCH_URL}?${params.toString()}`;
}

export interface OpenLibraryMatch {
  fields: Partial<BookMetadata>;
  /** Cover image to fetch, when the book has none of its own. */
  coverUrl: string | null;
}

function titlesMatch(a: string, b: string): boolean {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  return x !== "" && y !== "" && (x === y || x.startsWith(y) || y.startsWith(x));
}

/** Turns a search response into the fields it can fill, or null when nothing in it is this book. */
export function matchFromSearch(response: unknown, meta: Pick<BookMetadata, "title" | "isbn">): OpenLibraryMatch | null {
  const docs = (response as { docs?: unknown } | null)?.docs;
  const doc = Array.isArray(docs) ? (docs[0] as Record<string, unknown> | undefined) : undefined;
  if (!doc) return null;
  const title = typeof doc["title"] === "string" ? doc["title"] : "";
  // An ISBN hit is the book by definition; a title search has to prove it.
  if (!meta.isbn && !titlesMatch(title, meta.title)) return null;

  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
  const isbns = strings(doc["isbn"]);
  const fields: Partial<BookMetadata> = {
    authors: strings(doc["author_name"]),
    subjects: strings(doc["subject"]).slice(0, MAX_SUBJECTS),
    isbn: isbns.find((isbn) => isbn.length === 13) ?? isbns[0],
    publisher: strings(doc["publisher"])[0],
  };
  const pages = doc["number_of_pages_median"];
  if (typeof pages === "number" && pages > 0) fields.pages = pages;
  const year = doc["first_publish_year"];
  if (typeof year === "number") fields.published = String(year);
  const coverId = doc["cover_i"];
  return {
    fields,
    coverUrl: typeof coverId === "number" ? `https://covers.openlibrary.org/b/id/${coverId}-L.jpg?default=false` : null,
  };
}

/** Looks the book up. Any failure — offline, a bad response — yields null rather than failing the import. */
export async function lookUpOpenLibrary(meta: BookMetadata): Promise<Partial<BookMetadata> | null> {
  try {
    const response = await requestUrl({ url: searchUrl(meta), throw: false });
    if (response.status !== 200) return null;
    const match = matchFromSearch(response.json, meta);
    if (!match) return null;
    const fields = { ...match.fields };
    if (!meta.cover && match.coverUrl) {
      const image = await requestUrl({ url: match.coverUrl, throw: false });
      if (image.status === 200 && image.arrayBuffer.byteLength > 0) fields.cover = { data: image.arrayBuffer, extension: "jpg" };
    }
    return fields;
  } catch (error) {
    console.debug("[e-reader] Open Library lookup failed", error);
    return null;
  }
}
