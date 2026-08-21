// Resolves a Book note's `attachments` frontmatter list to the first
// readable (.epub/.pdf) vault file it points to. Lifted out of
// library-view.ts (which used to keep a private copy of this same logic) so
// the reader view can reuse it without duplicating it — see
// src/reader/reader-view.ts.

import type { App, TFile } from "obsidian";
import { findFileByName } from "./find-file";

const READABLE_EXTENSIONS = new Set(["epub", "pdf"]);

/**
 * Pure parsing step: turns a note's raw `attachments` frontmatter value
 * (a wikilink string, a bare filename, or a list of either) into an ordered
 * list of linkpaths. Split out from {@link resolveBookAttachment} so it is
 * testable without a fake App/MetadataCache.
 */
export function extractAttachmentLinkpaths(
  frontmatter: Record<string, unknown> | null | undefined,
  propertyName = "attachments",
): string[] {
  // `- [[Book.epub]]` in YAML is a list item containing two nested flow
  // sequences, so the filename arrives THREE levels deep:
  // [[["Book.epub"]]]. Quoted links arrive as plain strings. Collect every
  // string at any depth rather than assuming a nesting level.
  const linkpaths: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      const linkpath = value.replace(/^\[\[|\]\]$/g, "").split("|")[0]?.trim();
      if (linkpath) linkpaths.push(linkpath);
      return;
    }
    if (Array.isArray(value)) for (const item of value) collect(item);
  };
  collect(frontmatter?.[propertyName]);
  return linkpaths;
}

/**
 * Resolves a book note's `attachments` list to the first entry that points
 * at a readable (.epub/.pdf) vault file, in list order. Returns null when
 * there is no such entry — callers decide how to present that (data-model.md
 * notes multi-attachment disambiguation as a future refinement; this picks
 * the first readable match, matching the previous library-view behaviour).
 */
export function resolveBookAttachment(app: App, bookNote: TFile, propertyName = "attachments"): TFile | null {
  const cache = app.metadataCache.getFileCache(bookNote);

  // Preferred: Obsidian's own index of wikilinks found in frontmatter. It is
  // independent of how the link was quoted, which raw YAML parsing is not —
  // an unquoted `- [[Book.epub]]` is flow-sequence syntax and parses as a
  // nested array rather than a string. `key` is the property, indexed
  // entries appearing as `attachments.0`, `attachments.1`, and so on.
  for (const link of cache?.frontmatterLinks ?? []) {
    if (link.key !== propertyName && !link.key.startsWith(`${propertyName}.`)) continue;
    const dest = app.metadataCache.getFirstLinkpathDest(link.link, bookNote.path);
    if (dest && READABLE_EXTENSIONS.has(dest.extension)) return dest;
  }

  // Fallback: plain strings (a bare filename, not a wikilink) never appear in
  // frontmatterLinks, so parse the raw value too.
  const rawPaths = extractAttachmentLinkpaths(cache?.frontmatter, propertyName);
  for (const linkpath of rawPaths) {
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, bookNote.path);
    if (dest && READABLE_EXTENSIONS.has(dest.extension)) return dest;
  }

  // Last resort: link resolution only finds files Obsidian has indexed, and it
  // does not index every extension. Match against the vault's own file list by
  // name instead, which does not depend on the link index at all.
  const wanted = new Set<string>();
  for (const link of cache?.frontmatterLinks ?? []) {
    if (link.key === propertyName || link.key.startsWith(`${propertyName}.`)) wanted.add(basename(link.link));
  }
  for (const linkpath of rawPaths) wanted.add(basename(linkpath));
  if (wanted.size > 0) {
    for (const file of app.vault.getFiles()) {
      if (READABLE_EXTENSIONS.has(file.extension) && wanted.has(file.name)) return file;
    }
  }
  return null;
}

/** Filename portion of a linkpath, with any subpath or alias already stripped. */
function basename(linkpath: string): string {
  const withoutSubpath = linkpath.split("#")[0] ?? linkpath;
  const parts = withoutSubpath.split("/");
  return (parts[parts.length - 1] ?? withoutSubpath).trim();
}


/**
 * Resolves a book note's attachment to a vault-relative PATH, falling back to
 * a filesystem search when the Vault does not track the extension (.epub is
 * not indexed, so no vault-level API can find it).
 */
export async function resolveBookAttachmentPath(
  app: App,
  bookNote: TFile,
  propertyName = "attachments",
): Promise<{ path: string; extension: string; name: string } | null> {
  const indexed = resolveBookAttachment(app, bookNote, propertyName);
  if (indexed) return { path: indexed.path, extension: indexed.extension, name: indexed.name };

  const cache = app.metadataCache.getFileCache(bookNote);
  const candidates: string[] = [];
  for (const link of cache?.frontmatterLinks ?? []) {
    if (link.key === propertyName || link.key.startsWith(`${propertyName}.`)) candidates.push(link.link);
  }
  candidates.push(...extractAttachmentLinkpaths(cache?.frontmatter, propertyName));

  const readable = candidates.filter((c) => {
    const ext = c.split(".").pop()?.toLowerCase() ?? "";
    return READABLE_EXTENSIONS.has(ext);
  });
  if (readable.length === 0) return null;

  const path = await findFileByName(app, readable);
  if (!path) return null;
  const name = path.split("/").pop() ?? path;
  return { path, extension: name.split(".").pop()?.toLowerCase() ?? "", name };
}


/** Human-readable account of why resolution failed, shown in the reader's empty state. */
export async function describeAttachmentLookup(
  app: App,
  bookNote: TFile,
  propertyName = "attachments",
): Promise<string> {
  const cache = app.metadataCache.getFileCache(bookNote);
  const raw = cache?.frontmatter?.[propertyName];
  const links = (cache?.frontmatterLinks ?? [])
    .filter((l) => l.key === propertyName || l.key.startsWith(`${propertyName}.`))
    .map((l) => l.link);
  const parsed = extractAttachmentLinkpaths(cache?.frontmatter, propertyName);
  return [
    `note: ${bookNote.path}`,
    `frontmatter.${propertyName}: ${JSON.stringify(raw)}`,
    `frontmatterLinks: ${JSON.stringify(links)}`,
    `parsed linkpaths: ${JSON.stringify(parsed)}`,
  ].join("\n");
}
