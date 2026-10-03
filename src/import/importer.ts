// Turns an EPUB or PDF into a book: reads what the file says about itself,
// optionally fills the gaps from Open Library, moves the file (and a cover)
// to where the reader keeps book files, and writes the book's note.
//
// Nothing is written until the duplicate check has passed, and every write
// is undone if a later one fails, so an import either completes or leaves
// the vault as it found it — no half-written note pointing at nothing, no
// file moved with no note to show for it.

import type { App, TFile } from "obsidian";
import { resolveBookAttachment } from "../core/attachment";
import { isBookNote } from "../core/book-note";
import { applyStatus } from "../core/status";
import type { Settings } from "../settings/settings-model";
import { readEpubMetadata } from "./epub-metadata";
import { type BookMetadata, fillGaps } from "./metadata";
import { lookUpOpenLibrary } from "./open-library";
import { type BookIdentity, bookIdentity, buildFrontmatter, joinPath, safeFileName, sameBook } from "./plan";

export const IMPORTABLE_EXTENSIONS: ReadonlySet<string> = new Set(["epub", "pdf"]);

/** A book already in the vault (the inbox, a command), or one dropped in from outside it. */
export type ImportSource = { kind: "vault"; file: TFile } | { kind: "external"; name: string; data: ArrayBuffer };

export type ImportResult =
  | { status: "imported"; note: TFile; title: string }
  | { status: "duplicate"; existing: TFile; title: string }
  | { status: "unsupported" };

export type AttachResult =
  | { status: "attached"; file: TFile }
  /** The file is already some book's; attaching it again would make two books share it. */
  | { status: "in-use"; existing: TFile }
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
  // Likewise for the placeholder values some producers write.
  const placeholder = (value: string): boolean => /^(anonymous|unknown|unspecified|none|n\/a|-)$/i.test(value.trim());
  return {
    title: usableTitle && pdf.title ? pdf.title : fallbackTitle,
    authors: pdf.authors.filter((name) => !placeholder(name)),
    pages: pdf.pages,
    subjects: pdf.subject && !placeholder(pdf.subject) ? [pdf.subject] : [],
    cover: pdf.cover ? { data: pdf.cover, extension: "jpg" } : undefined,
  };
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

/** Undoes a failed write's steps, newest first, carrying on past any that fail. */
async function rollBack(undo: (() => Promise<unknown>)[]): Promise<void> {
  for (const step of [...undo].reverse()) {
    try {
      await step();
    } catch (undoError) {
      console.error("[e-reader] could not undo part of a failed import", undoError);
    }
  }
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
    return this.enqueue(() => this.run(source));
  }

  /**
   * Saves a book you do not have yet: a note with its details and cover but
   * no file. Refused, like an import, when the book is already a note.
   */
  addToWishlist(meta: BookMetadata): Promise<ImportResult> {
    return this.enqueue(async () => {
      const existing = this.findDuplicate(meta, null);
      if (existing) return { status: "duplicate", existing, title: meta.title };
      const note = await this.write(null, meta);
      const { status } = this.getSettings();
      await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
        applyStatus(fm, status, status.wishlist, true);
      });
      return { status: "imported", note, title: meta.title };
    });
  }

  /**
   * Gives an existing book note its file — a wishlist book arriving. The file
   * is moved (or copied in) and named after the note, linked from its
   * attachments, and anything the note does not already say is filled from
   * what the file says about itself. Nothing the note already has is changed.
   */
  attach(note: TFile, source: ImportSource): Promise<AttachResult> {
    return this.enqueue(() => this.runAttach(note, source));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
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
    if (existing) {
      // The wishlist book this file is, arriving: it joins that note rather
      // than being refused as a second copy.
      if (resolveBookAttachment(this.app, existing, settings.properties.attachments) === null) {
        const attached = await this.runAttach(existing, source);
        if (attached.status === "attached") return { status: "imported", note: existing, title: meta.title };
      }
      return { status: "duplicate", existing, title: meta.title };
    }

    const note = await this.write({ source, extension }, meta);
    return { status: "imported", note, title: meta.title };
  }

  private async runAttach(note: TFile, source: ImportSource): Promise<AttachResult> {
    const name = source.kind === "vault" ? source.file.name : source.name;
    const extension = extensionOf(name);
    if (!IMPORTABLE_EXTENSIONS.has(extension)) return { status: "unsupported" };
    if (source.kind === "vault") {
      const owner = this.ownerOf(source.file);
      if (owner && owner !== note) return { status: "in-use", existing: owner };
    }

    const { vault, fileManager } = this.app;
    const settings = this.getSettings();
    const data = source.kind === "vault" ? await vault.readBinary(source.file) : source.data;
    // Read only to fill what the note lacks, so a lookup is not worth its wait.
    const meta = await readMetadata(extension, data, note.basename, this.readPdf);
    const existing = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
    const undo: (() => Promise<unknown>)[] = [];

    try {
      const bookFile = await this.placeBookFile({ source, extension }, note.basename, note.path, undo);
      let coverFile: TFile | null = null;
      const coverName = settings.properties.cover;
      if (meta.cover && coverName.trim() !== "" && isEmpty(existing[coverName])) {
        coverFile = await this.writeCover(meta.cover, note.basename, note.path, undo);
      }
      const link = (file: TFile): string => `[[${this.app.metadataCache.fileToLinktext(file, note.path, false)}]]`;
      const filled = buildFrontmatter(meta, settings.properties, { book: null, cover: coverFile ? link(coverFile) : null });
      await fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(filled)) {
          if (key === settings.properties.marker || key === "title") continue;
          if (isEmpty(fm[key])) fm[key] = value;
        }
        const current = fm[settings.properties.attachments];
        const list = Array.isArray(current) ? current : isEmpty(current) ? [] : [current];
        fm[settings.properties.attachments] = [...list, link(bookFile)];
        // The book is here now, so it is no longer one you are waiting for.
        applyStatus(fm, settings.status, settings.status.wishlist, false);
      });
      return { status: "attached", file: bookFile };
    } catch (error) {
      await rollBack(undo);
      throw error;
    }
  }

  /** The book note that already links `file`, if any. */
  private ownerOf(file: TFile): TFile | null {
    const { marker, markerValue, attachments } = this.getSettings().properties;
    for (const note of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(note);
      if (!cache?.frontmatter || !isBookNote(cache.frontmatter, marker, markerValue)) continue;
      for (const link of cache.frontmatterLinks ?? []) {
        if (link.key !== attachments && !link.key.startsWith(`${attachments}.`)) continue;
        if (this.app.metadataCache.getFirstLinkpathDest(link.link, note.path)?.path === file.path) return note;
      }
    }
    return null;
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

  /** A book note that is this book already (plan.ts `sameBook`), or one that already links this file. */
  findDuplicate(meta: Pick<BookMetadata, "title" | "authors" | "isbn">, file: TFile | null): TFile | null {
    const { attachments } = this.getSettings().properties;
    const wanted = bookIdentity(meta);
    for (const note of this.bookNotes()) {
      if (file) {
        for (const link of this.app.metadataCache.getFileCache(note)?.frontmatterLinks ?? []) {
          if (link.key !== attachments && !link.key.startsWith(`${attachments}.`)) continue;
          if (this.app.metadataCache.getFirstLinkpathDest(link.link, note.path)?.path === file.path) return note;
        }
      }
      if (sameBook(wanted, this.identityOf(note))) return note;
    }
    return null;
  }

  /** Every book note in the vault. */
  bookNotes(): TFile[] {
    const { marker, markerValue } = this.getSettings().properties;
    return this.app.vault
      .getMarkdownFiles()
      .filter((note) => isBookNote(this.app.metadataCache.getFileCache(note)?.frontmatter, marker, markerValue));
  }

  /** What the duplicate check knows about a book note, from its title, first author and ISBN. */
  identityOf(note: TFile): BookIdentity {
    const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
    const title = typeof fm["title"] === "string" && fm["title"].trim() !== "" ? fm["title"] : note.basename;
    const author: unknown = fm["author"] ?? fm["authors"];
    const firstAuthor: unknown = Array.isArray(author) ? author[0] : author;
    const isbn: unknown = fm["isbn"];
    return bookIdentity({
      title,
      authors: typeof firstAuthor === "string" ? [firstAuthor] : [],
      isbn: typeof isbn === "string" || typeof isbn === "number" ? String(isbn) : undefined,
    });
  }

  /** Writes a new book note, with its file when there is one and a cover when there is one. */
  private async write(book: { source: ImportSource; extension: string } | null, meta: BookMetadata): Promise<TFile> {
    const { vault, fileManager } = this.app;
    const settings = this.getSettings();
    const name = safeFileName(meta.title);
    const notePath = this.availablePath(joinPath(settings.import.notesFolder, `${name}.md`));
    const undo: (() => Promise<unknown>)[] = [];

    try {
      const bookFile = book ? await this.placeBookFile(book, name, notePath, undo) : null;
      const coverFile = meta.cover ? await this.writeCover(meta.cover, name, notePath, undo) : null;

      await this.ensureFolder(parentOf(notePath), undo);
      const note = await vault.create(notePath, "");
      undo.push(() => vault.delete(note));
      const link = (file: TFile): string => `[[${this.app.metadataCache.fileToLinktext(file, notePath, false)}]]`;
      const frontmatter = buildFrontmatter(meta, settings.properties, {
        book: bookFile ? link(bookFile) : null,
        cover: coverFile ? link(coverFile) : null,
      });
      await fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => Object.assign(fm, frontmatter));
      return note;
    } catch (error) {
      await rollBack(undo);
      throw error;
    }
  }

  /** Moves a vault file, or writes a dropped one, to where book files go, named `name`. */
  private async placeBookFile(
    book: { source: ImportSource; extension: string },
    name: string,
    notePath: string,
    undo: (() => Promise<unknown>)[],
  ): Promise<TFile> {
    const { vault, fileManager } = this.app;
    const bookPath = await this.filePath(`${name}.${book.extension}`, notePath);
    const source = book.source;
    if (source.kind === "vault") {
      const bookFile = source.file;
      const from = bookFile.path;
      if (parentOf(from) !== parentOf(bookPath) || basenameOf(from) !== basenameOf(bookPath)) {
        await this.ensureFolder(parentOf(bookPath), undo);
        this.written.add(bookPath);
        await fileManager.renameFile(bookFile, bookPath);
        undo.push(() => fileManager.renameFile(bookFile, from));
      }
      return bookFile;
    }
    await this.ensureFolder(parentOf(bookPath), undo);
    this.written.add(bookPath);
    const created = await vault.createBinary(bookPath, source.data);
    undo.push(() => vault.delete(created));
    return created;
  }

  private async writeCover(
    cover: NonNullable<BookMetadata["cover"]>,
    name: string,
    notePath: string,
    undo: (() => Promise<unknown>)[],
  ): Promise<TFile> {
    const coverPath = await this.filePath(`${name} cover.${cover.extension}`, notePath);
    await this.ensureFolder(parentOf(coverPath), undo);
    this.written.add(coverPath);
    const created = await this.app.vault.createBinary(coverPath, cover.data);
    undo.push(() => this.app.vault.delete(created));
    return created;
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
