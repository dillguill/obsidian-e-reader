// Turns an EPUB or PDF into a book: reads what the file says about itself,
// optionally fills the gaps from Open Library, moves the file (and a cover)
// to where the reader keeps book files, and writes the book's note.
//
// Nothing is written until the duplicate check has passed, and every write
// is undone if a later one fails, so an import either completes or leaves
// the vault as it found it — no half-written note pointing at nothing, no
// file moved with no note to show for it.

import type { App, TFile } from "obsidian";
import { isBookNote } from "../core/book-note";
import type { Settings } from "../settings/settings-model";
import { readEpubMetadata } from "./epub-metadata";
import { type BookMetadata, fillGaps } from "./metadata";
import { lookUpOpenLibrary } from "./open-library";
import { buildFrontmatter, duplicateKeys, joinPath, safeFileName } from "./plan";

export const IMPORTABLE_EXTENSIONS: ReadonlySet<string> = new Set(["epub", "pdf"]);

/** A book already in the vault (the inbox, a command), or one dropped in from outside it. */
export type ImportSource = { kind: "vault"; file: TFile } | { kind: "external"; name: string; data: ArrayBuffer };

export type ImportResult =
  | { status: "imported"; note: TFile; title: string }
  | { status: "duplicate"; existing: TFile; title: string }
  | { status: "unsupported" };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function basenameOf(name: string): string {
  const slash = name.lastIndexOf("/");
  const file = slash >= 0 ? name.slice(slash + 1) : name;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

/** What a PDF says about itself. Supplied by the PDF adapter, which keeps pdf.js to itself. */
export type PdfMetadataReader = (data: ArrayBuffer) => Promise<{
  title: string | null;
  authors: string[];
  subject: string | null;
  pages: number;
  cover: ArrayBuffer | null;
}>;

async function readMetadata(
  extension: string,
  data: ArrayBuffer,
  fallbackTitle: string,
  readPdf: PdfMetadataReader,
): Promise<BookMetadata> {
  if (extension === "epub") return readEpubMetadata(data, fallbackTitle);
  const pdf = await readPdf(data);
  // A PDF's Title is often whatever program made it filled in: the source
  // file's name, or "Untitled". The file name is a better guess than that.
  const usableTitle = pdf.title && !/(\.(docx?|pdf|indd|tex|dvi|odt|pages)$)|^untitled\b|^microsoft word/i.test(pdf.title);
  return {
    title: usableTitle && pdf.title ? pdf.title : fallbackTitle,
    authors: pdf.authors,
    pages: pdf.pages,
    subjects: pdf.subject ? [pdf.subject] : [],
    cover: pdf.cover ? { data: pdf.cover, extension: "jpg" } : undefined,
  };
}

export class BookImporter {
  /** One import at a time, so two arriving together cannot both pass the duplicate check. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Paths this importer has just written, so the inbox does not try to import its own output. */
  private readonly written = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly getSettings: () => Settings,
    private readonly readPdf: PdfMetadataReader,
  ) {}

  /** Whether `path` was written by an import rather than arriving from outside. */
  wrote(path: string): boolean {
    return this.written.has(path);
  }

  import(source: ImportSource): Promise<ImportResult> {
    const run = this.queue.then(() => this.run(source));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(source: ImportSource): Promise<ImportResult> {
    const name = source.kind === "vault" ? source.file.name : source.name;
    const extension = extensionOf(name);
    if (!IMPORTABLE_EXTENSIONS.has(extension)) return { status: "unsupported" };
    const settings = this.getSettings();

    const data = source.kind === "vault" ? await this.app.vault.readBinary(source.file) : source.data;
    let meta = await readMetadata(extension, data, basenameOf(name), this.readPdf);
    if (settings.import.lookUpMetadata) {
      const extra = await lookUpOpenLibrary(meta);
      if (extra) meta = fillGaps(meta, extra);
    }

    const existing = this.findDuplicate(meta, source.kind === "vault" ? source.file : null);
    if (existing) return { status: "duplicate", existing, title: meta.title };

    const note = await this.write(source, extension, data, meta);
    return { status: "imported", note, title: meta.title };
  }

  /** Every file some book note already links in its attachments. */
  attachedPaths(): Set<string> {
    const { marker, markerValue, attachments } = this.getSettings().properties;
    const paths = new Set<string>();
    for (const note of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(note);
      if (!cache?.frontmatter || !isBookNote(cache.frontmatter, marker, markerValue)) continue;
      for (const link of cache.frontmatterLinks ?? []) {
        if (link.key !== attachments && !link.key.startsWith(`${attachments}.`)) continue;
        const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, note.path);
        if (dest) paths.add(dest.path);
      }
    }
    return paths;
  }

  /** A book note that is this book already: the same ISBN, the same title and author, or one that already links this file. */
  findDuplicate(meta: Pick<BookMetadata, "title" | "authors" | "isbn">, file: TFile | null): TFile | null {
    const { marker, markerValue, attachments } = this.getSettings().properties;
    const wanted = new Set(duplicateKeys(meta));
    for (const note of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(note);
      const fm = cache?.frontmatter;
      if (!fm || !isBookNote(fm, marker, markerValue)) continue;
      if (file) {
        for (const link of cache?.frontmatterLinks ?? []) {
          if (link.key !== attachments && !link.key.startsWith(`${attachments}.`)) continue;
          if (this.app.metadataCache.getFirstLinkpathDest(link.link, note.path)?.path === file.path) return note;
        }
      }
      const title = typeof fm["title"] === "string" ? fm["title"] : note.basename;
      const author = fm["author"];
      const firstAuthor = Array.isArray(author) ? author[0] : author;
      const isbn = fm["isbn"];
      const keys = duplicateKeys({
        title,
        authors: typeof firstAuthor === "string" ? [firstAuthor.replace(/^\[\[|\]\]$/g, "")] : [],
        isbn: typeof isbn === "string" || typeof isbn === "number" ? String(isbn) : undefined,
      });
      if (keys.some((key) => wanted.has(key))) return note;
    }
    return null;
  }

  private async write(source: ImportSource, extension: string, data: ArrayBuffer, meta: BookMetadata): Promise<TFile> {
    const { vault, fileManager } = this.app;
    const settings = this.getSettings();
    const name = safeFileName(meta.title);
    const notePath = this.availablePath(joinPath(settings.import.notesFolder, `${name}.md`));
    const undo: (() => Promise<unknown>)[] = [];

    try {
      // The book file.
      let bookFile: TFile;
      const bookPath = await this.filePath(`${name}.${extension}`, notePath);
      if (source.kind === "vault") {
        bookFile = source.file;
        const from = bookFile.path;
        if (parentOf(from) !== parentOf(bookPath) || basenameOf(from) !== name) {
          await this.ensureFolder(parentOf(bookPath), undo);
          this.written.add(bookPath);
          await fileManager.renameFile(bookFile, bookPath);
          undo.push(() => fileManager.renameFile(bookFile, from));
        }
      } else {
        await this.ensureFolder(parentOf(bookPath), undo);
        this.written.add(bookPath);
        bookFile = await vault.createBinary(bookPath, data);
        undo.push(() => vault.delete(bookFile));
      }

      // The cover.
      let coverFile: TFile | null = null;
      if (meta.cover) {
        const coverPath = await this.filePath(`${name} cover.${meta.cover.extension}`, notePath);
        await this.ensureFolder(parentOf(coverPath), undo);
        this.written.add(coverPath);
        const created = await vault.createBinary(coverPath, meta.cover.data);
        coverFile = created;
        undo.push(() => vault.delete(created));
      }

      // The note.
      await this.ensureFolder(parentOf(notePath), undo);
      const note = await vault.create(notePath, "");
      undo.push(() => vault.delete(note));
      const link = (file: TFile): string => `[[${this.app.metadataCache.fileToLinktext(file, notePath, false)}]]`;
      const frontmatter = buildFrontmatter(meta, settings.properties, {
        book: link(bookFile),
        cover: coverFile ? link(coverFile) : null,
      });
      await fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => Object.assign(fm, frontmatter));
      return note;
    } catch (error) {
      for (const step of undo.reverse()) {
        try {
          await step();
        } catch (undoError) {
          console.error("[e-reader] could not undo part of a failed import", undoError);
        }
      }
      throw error;
    }
  }

  /** Where a book file or cover goes: the configured folder, or Obsidian's attachment location for the note. */
  private async filePath(fileName: string, notePath: string): Promise<string> {
    const folder = this.getSettings().import.filesFolder;
    if (folder !== "") return this.availablePath(joinPath(folder, fileName));
    return this.app.fileManager.getAvailablePathForAttachment(fileName, notePath);
  }

  /** `path`, or the same with " 1", " 2"… before the extension until nothing is there. */
  private availablePath(path: string): string {
    const dot = path.lastIndexOf(".");
    const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
    let candidate = path;
    for (let n = 1; this.app.vault.getAbstractFileByPath(candidate); n++) candidate = `${stem} ${n}${ext}`;
    return candidate;
  }

  /** Creates `folder` and any missing parents, recording each one created so a failure can remove it. */
  private async ensureFolder(folder: string, undo: (() => Promise<unknown>)[]): Promise<void> {
    if (folder === "") return;
    const parts = folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join("/");
      if (this.app.vault.getAbstractFileByPath(path)) continue;
      try {
        const created = await this.app.vault.createFolder(path);
        undo.push(() => this.app.vault.delete(created, true));
      } catch (error) {
        // The vault index can miss a folder the disk has — one differing
        // only in case on a case-insensitive filesystem, say. It exists, so
        // carry on into it.
        if (!(await this.app.vault.adapter.exists(path))) throw error;
      }
    }
  }
}
