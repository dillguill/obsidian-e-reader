// The reader itself.
//
// It is a FileView whose `file` is the BOOK NOTE, and — this is the part
// that matters — it changes that file only by going through FileView's own
// `loadFile()`. Obsidian's Outline, Properties and Backlinks panes all
// extend one internal base class that follows the workspace's `file-open`
// event, and `file-open` is fired (via `requestActiveLeafEvents`) from
// inside `loadFile`. Assigning `this.file` directly renders the same
// document but leaves every native pane pointing at whatever was open
// before, so the book note's properties and outline never appear.
//
// Practically: put the note's path in the view state under `file` and let
// FileView.setState drive; do the actual book loading from `onLoadFile`.

import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import { FileView, Menu, Notice, TFile } from "obsidian";
import { addEntry } from "../annotations/store";
import { describeAttachmentLookup, resolveBookAttachmentPath } from "../core/attachment";
import { parseLocator, serializeLocator } from "../core/locator";
import type { Locator } from "../core/types";
import type { Settings } from "../settings/settings-model";
import { createEpubEngine } from "./epub/adapter";
import type { EngineSelection, ReaderEngine } from "./engine";
import { createPdfEngine } from "./pdf/adapter";
import { type ReadingPosition, positionChanged, shouldFlushNow } from "./position";
import { clampProgress } from "./progress";

export const READER_VIEW_TYPE = "ereader-reader";

export interface ReaderViewState {
  /** The book note's path. FileView reads this and calls `loadFile` itself. */
  file?: string;
  /** Accepted for workspaces saved before `file` became the source of truth. */
  bookNotePath?: string;
  [key: string]: unknown;
}

const POSITION_FLUSH_INTERVAL_MS = 2000;
const PROGRESS_PROPERTY = "progress";
const LAST_READ_PROPERTY = "last-read";
const BOOKMARK_TYPE = "bookmark";

function isReaderViewState(state: unknown): state is ReaderViewState {
  return typeof state === "object" && state !== null;
}

export class ReaderView extends FileView {
  private engine: ReaderEngine | null = null;
  private contentRoot: HTMLElement | null = null;
  private lastWritten: ReadingPosition | null = null;
  private lastFlushAt = 0;
  private loadToken = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => Settings,
  ) {
    super(leaf);
    this.navigation = true;
    // FileView's own setState closes the leaf when `this.file` ends up null
    // and this is false (verified against Obsidian's real FileView.setState,
    // not just the .d.ts) — an unresolvable path should show our own "not
    // found" state instead of the leaf silently vanishing.
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
    if (this.file) await this.loadBook(this.file);
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    // Older saved workspaces carry the path under `bookNotePath`; FileView
    // only understands `file`, and only a `file` key makes it call loadFile.
    if (isReaderViewState(state) && state.file === undefined && typeof state.bookNotePath === "string") {
      state.file = state.bookNotePath;
    }
    await super.setState(state, result);
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await this.loadBook(file);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await this.flushPosition(true);
    this.engine?.destroy();
    this.engine = null;
    this.lastWritten = null;
    this.lastFlushAt = 0;
    this.contentRoot?.empty();
  }

  override async onClose(): Promise<void> {
    await this.flushPosition(true);
    this.engine?.destroy();
    this.engine = null;
    await super.onClose();
  }

  /** The book note this reader is reading, or null when it opened a bare file. */
  private bookNote(): TFile | null {
    return this.file && this.file.extension === "md" ? this.file : null;
  }

  private async loadBook(file: TFile): Promise<void> {
    const root = this.contentRoot;
    if (!root) return;
    const token = ++this.loadToken;

    this.engine?.destroy();
    this.engine = null;
    root.empty();

    // Opening an .epub straight from the file explorer gives us the book
    // itself rather than a note about it; there is nothing to resolve.
    const attachment =
      file.extension === "md"
        ? await resolveBookAttachmentPath(this.app, file)
        : { path: file.path, extension: file.extension, name: file.name };

    if (!attachment) {
      // Nothing to read: fall back to the note itself rather than a dead end.
      console.debug("[e-reader] no attachment; opening the note\n" + (await describeAttachmentLookup(this.app, file)));
      await this.leaf.openFile(file);
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
    engine.onContextMenu((position) => this.showAnnotationMenu(position));

    const restored = this.readStoredLocator(file);
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

  /** Scrolls this reader to `locator`. Used by the highlights sidebar. */
  async goToLocator(locator: Locator): Promise<void> {
    try {
      await this.engine?.goTo(locator);
    } catch (error) {
      console.error("[e-reader] failed to navigate to a locator", error);
    }
  }

  /** The current selection in the rendered document, or null. */
  selection(): EngineSelection | null {
    return this.engine?.getSelection() ?? null;
  }

  private showAnnotationMenu(position: { x: number; y: number }): void {
    const menu = new Menu();
    const selection = this.selection();
    const types = this.getSettings().annotationTypes;

    if (selection) {
      for (const type of types) {
        menu.addItem((item) =>
          item
            .setTitle(`Highlight — ${type}`)
            .setIcon("highlighter")
            .onClick(() => void this.createEntry(type, selection)),
        );
      }
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle("Add bookmark here")
        .setIcon("bookmark")
        .onClick(() => void this.createEntry(BOOKMARK_TYPE, null)),
    );
    menu.showAtPosition(position);
  }

  /**
   * Writes a highlight (or, with a null selection, a bookmark) into the book
   * note. This is a reader action, so it is one of the writes FR-037a allows.
   */
  async createEntry(type: string, selection: EngineSelection | null): Promise<void> {
    const note = this.bookNote();
    if (!note) {
      new Notice("E-Reader: highlights are stored in a book note — open this book from your library.");
      return;
    }
    const hint = selection?.locator ?? this.engine?.currentLocator() ?? undefined;
    try {
      await addEntry(this.app, note, {
        type,
        exact: selection?.exact ?? "",
        prefix: selection?.prefix ?? "",
        suffix: selection?.suffix ?? "",
        ...(hint === undefined ? {} : { hint }),
      });
    } catch (error) {
      console.error("[e-reader] failed to write an entry", error);
      new Notice("E-Reader: could not save that highlight — see the console.");
    }
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
    const bookNote = this.bookNote();
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
