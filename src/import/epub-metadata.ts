// Metadata and cover from an EPUB's own package document (the OPF).

import JSZip from "jszip";
import { type BookCover, type BookMetadata, coverExtension } from "./metadata";
import { findElements } from "./xml";

/** The package document's path inside the archive, from META-INF/container.xml. */
export function opfPathFromContainer(containerXml: string): string | null {
  for (const rootfile of findElements(containerXml, "rootfile")) {
    const path = rootfile.attrs["full-path"];
    if (path) return path;
  }
  return null;
}

export interface OpfMetadata extends Omit<BookMetadata, "cover" | "title"> {
  title: string | null;
  /** The cover image's path inside the archive, and its media type. */
  cover: { path: string; mediaType: string | undefined } | null;
}

/** Resolves `href` against the folder the package document sits in. */
function resolveHref(opfPath: string, href: string): string {
  const parts = opfPath.split("/").slice(0, -1);
  for (const segment of decodeURIComponent(href.split("#")[0] ?? "").split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

/** An ISBN-10 or ISBN-13 in `value`, digits only (X kept), or null. */
export function extractIsbn(value: string): string | null {
  const compact = value.replace(/^urn:isbn:/i, "").replace(/^isbn:?/i, "").replace(/[\s-]/g, "");
  if (/^\d{13}$/.test(compact) || /^\d{9}[\dXx]$/.test(compact)) return compact.toUpperCase();
  return null;
}

export function parseOpf(opfXml: string, opfPath: string): OpfMetadata {
  const first = (name: string): string | undefined => findElements(opfXml, name).find((el) => el.text !== "")?.text;

  const authors = findElements(opfXml, "creator")
    // EPUB 2 marks a creator's role inline; anyone who is not an author
    // (an editor, an illustrator) stays out of the author list. EPUB 3 moves
    // roles into <meta refines>, which is rarer and is not read here.
    .filter((el) => (el.attrs["role"] ?? "aut") === "aut")
    .map((el) => el.text)
    .filter((name) => name !== "");

  let isbn: string | undefined;
  for (const id of findElements(opfXml, "identifier")) {
    const scheme = (id.attrs["scheme"] ?? "").toLowerCase();
    const candidate = extractIsbn(id.text);
    if (candidate && (scheme === "isbn" || scheme === "" || /isbn/i.test(id.text))) {
      isbn = candidate;
      break;
    }
  }

  const items = findElements(opfXml, "item");
  // EPUB 3 flags the cover in the manifest; EPUB 2 points at it from a
  // <meta name="cover"> in the metadata.
  let coverItem = items.find((item) => (item.attrs["properties"] ?? "").split(/\s+/).includes("cover-image"));
  if (!coverItem) {
    const coverId = findElements(opfXml, "meta").find((meta) => meta.attrs["name"] === "cover")?.attrs["content"];
    if (coverId) coverItem = items.find((item) => item.attrs["id"] === coverId);
  }
  // Last resort: an image whose id or file name says it is the cover.
  coverItem ??= items.find(
    (item) => (item.attrs["media-type"] ?? "").startsWith("image/") && /cover/i.test(`${item.attrs["id"]} ${item.attrs["href"]}`),
  );
  const coverHref = coverItem?.attrs["href"];

  const date = first("date");
  return {
    title: first("title") ?? null,
    authors,
    language: first("language"),
    published: date,
    publisher: first("publisher"),
    // Descriptions are often HTML that was escaped into the XML, which
    // decoding turns back into tags.
    description: first("description")
      ?.replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,;:!?])/g, "$1")
      .trim() || undefined,
    isbn,
    subjects: findElements(opfXml, "subject")
      .map((el) => el.text)
      .filter((text) => text !== ""),
    cover: coverHref ? { path: resolveHref(opfPath, coverHref), mediaType: coverItem?.attrs["media-type"] } : null,
  };
}

/** Reads an EPUB's metadata and cover. `fallbackTitle` is used when the package names none. */
export async function readEpubMetadata(data: ArrayBuffer, fallbackTitle: string): Promise<BookMetadata> {
  const zip = await JSZip.loadAsync(data);
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container ? opfPathFromContainer(container) : null;
  const opfXml = opfPath ? await zip.file(opfPath)?.async("string") : undefined;
  if (!opfPath || !opfXml) return { title: fallbackTitle, authors: [], subjects: [] };

  const opf = parseOpf(opfXml, opfPath);
  let cover: BookCover | undefined;
  if (opf.cover) {
    const extension = coverExtension(opf.cover.mediaType, opf.cover.path);
    const bytes = extension ? await zip.file(opf.cover.path)?.async("arraybuffer") : undefined;
    if (extension && bytes && bytes.byteLength > 0) cover = { data: bytes, extension };
  }
  const { cover: _cover, title, ...rest } = opf;
  return { ...rest, title: title ?? fallbackTitle, cover };
}
