// What an import knows about a book before its note is written. Every field
// but the title is optional: a file carries what it carries, and a lookup
// only ever fills gaps, never overrides what the file itself said.

export interface BookCover {
  data: ArrayBuffer;
  /** File extension without the dot: jpg, png, gif, webp. */
  extension: string;
}

export interface BookMetadata {
  title: string;
  authors: string[];
  language?: string;
  /** A year or a full date, as the source gave it. */
  published?: string;
  publisher?: string;
  description?: string;
  isbn?: string;
  pages?: number;
  subjects: string[];
  cover?: BookCover;
}

/** Copies into `base` only the fields it is missing. */
export function fillGaps(base: BookMetadata, extra: Partial<BookMetadata>): BookMetadata {
  const merged: BookMetadata = { ...base, authors: [...base.authors], subjects: [...base.subjects] };
  if (merged.authors.length === 0 && extra.authors?.length) merged.authors = [...extra.authors];
  if (merged.subjects.length === 0 && extra.subjects?.length) merged.subjects = [...extra.subjects];
  for (const key of ["language", "published", "publisher", "description", "isbn", "pages", "cover"] as const) {
    if (merged[key] === undefined && extra[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = extra[key];
  }
  return merged;
}

/** The extension a cover's media type is saved under, or null for one that is not an image a note can show. */
export function coverExtension(mediaType: string | undefined, href = ""): string | null {
  const type = (mediaType ?? "").toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/gif") return "gif";
  if (type === "image/webp") return "webp";
  const ext = href.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase();
  if (ext === "jpeg" || ext === "jpg") return "jpg";
  if (ext === "png" || ext === "gif" || ext === "webp") return ext;
  return null;
}
