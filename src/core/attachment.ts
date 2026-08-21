// Resolves a Book note's `attachments` frontmatter list to the first
// readable (.epub/.pdf) vault file it points to. Lifted out of
// library-view.ts (which used to keep a private copy of this same logic) so
// the reader view can reuse it without duplicating it — see
// src/reader/reader-view.ts.

import type { App, TFile } from "obsidian";

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
  const attachments = frontmatter?.[propertyName];
  const list: unknown[] = Array.isArray(attachments) ? attachments : attachments ? [attachments] : [];
  const linkpaths: string[] = [];
  // An unquoted `- [[Book.epub]]` is valid YAML flow-sequence syntax, so it
  // parses as a NESTED ARRAY rather than a string. Quoted links arrive as
  // strings. Flatten one level so both spellings resolve.
  const flat: unknown[] = list.flatMap((item) => (Array.isArray(item) ? (item as unknown[]) : [item]));
  for (const item of flat) {
    if (typeof item !== "string") continue;
    const linkpath = item.replace(/^\[\[|\]\]$/g, "").split("|")[0]?.trim();
    if (linkpath) linkpaths.push(linkpath);
  }
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
