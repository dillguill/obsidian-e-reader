// The reader itself: an ItemView (concretely a FileView, so Obsidian's own
// properties/backlinks/search panes see the BOOK NOTE as this view's active
// file — see the `file` handling below) that resolves a book note's
// attachment, picks an adapter by extension, and renders it.

import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import { FileView, Notice, TFile } from "obsidian";
import { describeAttachmentLookup, resolveBookAttachmentPath } from "../core/attachment";
import { parseLocator, serializeLocator } from "../core/locator";
import type { Locator } from "../core/types";
import { createEpubEngine } from "./epub/adapter";
import type { ReaderEngine } from "./engine";
import { createPdfEngine } from "./pdf/adapter";
import { type ReadingPosition, positionChanged, shouldFlushNow } from "./position";
import { clampProgress } from "./progress";

export const READER_VIEW_TYPE = "ereader-reader";

export interface ReaderViewState {
  bookNotePath: string;
  // Obsidian's own ViewState.state is a plain `Record<string, unknown>` bag
  // (FileView's getState also folds a `file` key into it — see setState
  // below) — this index signature just admits that reality.
  [key: string]: unknown;
}

const POSITION_FLUSH_INTERVAL_MS = 2000;
const PROGRESS_PROPERTY = "progress";
const LAST_READ_PROPERTY = "last-read";

function isReaderViewState(state: unknown): state is Partial<ReaderViewState> {
  return typeof state === "object" && state !== null;
}

export class ReaderView extends FileView {
  private bookNotePath: string | null = null;
  private engine: ReaderEngine | null = null;
  private contentRoot: HTMLElement | null = null;
  private lastWritten: ReadingPosition | null = null;
  private lastFlushAt = 0;
  private loadToken = 0;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
    // FileView's own setState closes the leaf when `this.file` ends up null
    // and this is false (verified against Obsidian's real FileView.setState,
    // not just the .d.ts) — an unresolvable bookNotePath should show our own
    // "not found" state instead of the leaf silently vanishing.
    this.allowNoFile = true;
  }

  override getViewType(): string {
    return READER_VIEW_TYPE;
  }

  override getDisplayText(): string {
    if (!this.file) return "Reader";
    const cache = this.app.metadataCache.getFileCache(this.file);
    const title = cache?.frontmatter?.["title"];
    return typeof title === "string" && title.trim() !== "" ? title : this.file.basename;
  }

  override getIcon(): string {
    return "book-open";
  }

  override async onOpen(): Promise<void> {
    // Our own child div — never Obsidian's contentEl directly — so we can
    // freely rebuild it (`.empty()` + repopulate) on every book switch.
    this.contentRoot = this.contentEl.createDiv({ cls: "ereader-reader" });
    this.registerInterval(
      window.setInterval(() => {
        void this.flushPosition(false);
      }, POSITION_FLUSH_INTERVAL_MS),
    );
    if (this.bookNotePath) await this.loadBook();
  }

  override async onClose(): Promise<void> {
    await this.flushPosition(true);
    this.engine?.destroy();
    this.engine = null;
    await super.onClose();
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), bookNotePath: this.bookNotePath };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    if (isReaderViewState(state) && typeof state.bookNotePath === "string" && state.bookNotePath !== this.bookNotePath) {
      if (this.bookNotePath) await this.flushPosition(true);
      this.bookNotePath = state.bookNotePath;
      const abstractFile = this.app.vault.getAbstractFileByPath(state.bookNotePath);
      this.file = abstractFile instanceof TFile ? abstractFile : null;
      this.lastWritten = null;
      this.lastFlushAt = 0;
      if (this.contentRoot) await this.loadBook();
    }
    await super.setState(state, result);
  }

  private async loadBook(): Promise<void> {
    const root = this.contentRoot;
    if (!root) return;
    const token = ++this.loadToken;
    const bookNote = this.file;
    if (!bookNote) {
      this.engine?.destroy();
      this.engine = null;
      root.empty();
      root.createDiv({ cls: "ereader-reader__empty", text: "Book note not found." });
      return;
    }

    this.engine?.destroy();
    this.engine = null;
    root.empty();

    const attachment = await resolveBookAttachmentPath(this.app, bookNote);
    if (!attachment) {
      const detail = await describeAttachmentLookup(this.app, bookNote);
      const box = root.createDiv({ cls: "ereader-reader__empty" });
      box.createDiv({ text: "No readable attachment (.epub or .pdf) found on this note." });
      box.createEl("pre", { text: detail });
      console.error("[e-reader] attachment lookup failed\n" + detail);
      return;
    }

    let engine: ReaderEngine;
    try {
      engine = attachment.extension === "epub" ? createEpubEngine(this.app) : createPdfEngine(this.app);
      const viewport = root.createDiv({ cls: "ereader-reader__viewport" });
      await engine.open(attachment.path, viewport);
    } catch (error) {
      console.error("[e-reader] failed to open book", error);
      root.empty();
      root.createDiv({ cls: "ereader-reader__empty", text: `Could not open ${attachment.name}: ${String(error)}` });
      new Notice(`E-Reader: could not open ${attachment.name}`);
      return;
    }

    // A rapid book switch may have raced this async load; the newer call
    // already tore down and replaced whatever we just built.
    if (token !== this.loadToken) {
      engine.destroy();
      return;
    }
    this.engine = engine;

    const restored = this.readStoredLocator(bookNote);
    if (restored) {
      try {
        await engine.goTo(restored);
      } catch (error) {
        console.error("[e-reader] failed to restore reading position", error);
      }
    }
    this.lastWritten = this.currentPosition();
    this.lastFlushAt = Date.now();
  }

  private readStoredLocator(bookNote: TFile): Locator | null {
    const cache = this.app.metadataCache.getFileCache(bookNote);
    const raw = cache?.frontmatter?.[LAST_READ_PROPERTY];
    return typeof raw === "string" ? parseLocator(raw) : null;
  }

  private currentPosition(): ReadingPosition | null {
    if (!this.engine) return null;
    const locator = this.engine.currentLocator();
    if (!locator) return null;
    return { progress: clampProgress(this.engine.progress()), locator: serializeLocator(locator) };
  }

  /**
   * Writes progress/last-read to the book note's frontmatter — and only
   * those two keys (FileManager.processFrontMatter mutates the parsed
   * frontmatter object in place; nothing else is touched). Skipped when the
   * position hasn't changed, and (unless `force`) debounced against
   * POSITION_FLUSH_INTERVAL_MS.
   */
  private async flushPosition(force: boolean): Promise<void> {
    const bookNote = this.file;
    if (!bookNote || !this.engine) return;
    const current = this.currentPosition();
    if (!current || !positionChanged(this.lastWritten, current)) return;
    if (!force && !shouldFlushNow(Date.now() - this.lastFlushAt, POSITION_FLUSH_INTERVAL_MS)) return;

    this.lastWritten = current;
    this.lastFlushAt = Date.now();
    try {
      await this.app.fileManager.processFrontMatter(bookNote, (frontmatter: Record<string, unknown>) => {
        frontmatter[PROGRESS_PROPERTY] = current.progress;
        frontmatter[LAST_READ_PROPERTY] = current.locator;
      });
    } catch (error) {
      console.error("[e-reader] failed to write reading position", error);
    }
  }
}
