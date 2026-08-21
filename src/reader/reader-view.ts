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
import { addEntry, listEntries, removeEntry } from "../annotations/store";
import type { Entry } from "../annotations/entry";
import type { ReaderEvents } from "../core/reader-events";
import { describeAttachmentLookup, resolveBookAttachment, resolveBookAttachmentPath } from "../core/attachment";
import { parseLocator, serializeLocator } from "../core/locator";
import { RESERVED_ENTRY_TYPE, type Locator } from "../core/types";
import type { Settings } from "../settings/settings-model";
import { createEpubEngine } from "./epub/adapter";
import type { EngineSelection, OutlineNode, PaintedHighlight, ReaderEngine } from "./engine";
import { createPdfEngine } from "./pdf/adapter";
import { type ReadingPosition, positionChanged, shouldFlushNow } from "./position";
import { clampProgress } from "./progress";
import { ReaderToolbar } from "./toolbar";
import { toolbarState } from "./toolbar-model";
import { stepScale } from "./zoom";

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
const BOOKMARK_TYPE = RESERVED_ENTRY_TYPE;

function isReaderViewState(state: unknown): state is ReaderViewState {
  return typeof state === "object" && state !== null;
}

export class ReaderView extends FileView {
  private engine: ReaderEngine | null = null;
  private contentRoot: HTMLElement | null = null;
  private toolbar: ReaderToolbar | null = null;
  private lastWritten: ReadingPosition | null = null;
  private lastFlushAt = 0;
  private loadToken = 0;
  /** The open book's table of contents. Built once per book — for an EPUB it
   * costs a load of every section named in the TOC to resolve each href to a
   * CFI, which is far too slow to repeat on every sidebar render. */
  private cachedOutline: OutlineNode[] | null = null;
  /** The book note's bookmark entries, for the toolbar's filled state. */
  private bookmarks: Entry[] = [];
  /**
   * Signature of the entries last applied. The reader writes progress into
   * the book note's frontmatter every couple of seconds, and every one of
   * those writes fires `metadataCache.changed` — repainting the whole book
   * each time, for a change that cannot possibly have touched an entry.
   */
  private lastEntrySignature: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => Settings,
    private readonly saveSettings: () => void,
    private readonly events: ReaderEvents,
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
    // The toolbar is built once and lives above the viewport, which is what
    // `loadBook` empties and rebuilds; rebuilding it per book would drop the
    // listeners with it.
    this.toolbar = new ReaderToolbar(this.contentRoot, this, {
      zoomIn: () => void this.zoom(1),
      zoomOut: () => void this.zoom(-1),
      goToPage: (page) => void this.goToPage(page),
      displayOptions: () => this.engine?.displayOptions() ?? [],
      toggleHighlights: () => void this.toggleHighlights(),
      toggleBookmark: () => void this.toggleBookmark(),
    });
    this.toolbar.setVisible(false);

    this.registerInterval(
      window.setInterval(() => {
        this.announcePosition();
        void this.flushPosition(false);
      }, POSITION_FLUSH_INTERVAL_MS),
    );

    // An entry edited in the note — or written by this reader, or by the
    // highlights pane — arrives here the same way the sidebar sees it.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file === this.bookNote()) void this.refreshEntries();
      }),
    );
    // An EPUB renders inside iframes that inherit none of the vault's CSS, so
    // a theme switch has to be pushed into them.
    this.registerEvent(this.app.workspace.on("css-change", () => this.engine?.refreshTheme()));

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
    this.cachedOutline = null;
    this.bookmarks = [];
    this.lastEntrySignature = null;
    this.lastWritten = null;
    this.lastFlushAt = 0;
    this.toolbar?.setVisible(false);
    this.clearViewport();
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

  /** The element each engine renders into, rebuilt per book. */
  private viewportEl(): HTMLElement | null {
    return this.contentRoot?.querySelector<HTMLElement>(".ereader-reader__viewport") ?? null;
  }

  private clearViewport(): void {
    this.viewportEl()?.remove();
    this.contentRoot?.querySelector(".ereader-reader__empty")?.remove();
  }

  private async loadBook(file: TFile): Promise<void> {
    const root = this.contentRoot;
    if (!root) return;
    const token = ++this.loadToken;

    this.engine?.destroy();
    this.engine = null;
    this.cachedOutline = null;
    this.bookmarks = [];
    this.lastEntrySignature = null;
    this.toolbar?.setVisible(false);
    this.clearViewport();

    // Opening an .epub straight from the file explorer gives us the book
    // itself rather than a note about it; there is nothing to resolve.
    const attachment =
      file.extension === "md"
        ? await resolveBookAttachmentPath(this.app, file, this.getSettings().properties.attachments)
        : { path: file.path, extension: file.extension, name: file.name };

    if (!attachment) {
      // Nothing to read: fall back to the note itself rather than a dead end.
      console.debug("[e-reader] no attachment; opening the note\n" + (await describeAttachmentLookup(this.app, file)));
      await this.leaf.openFile(file);
      return;
    }

    // "Obsidian default" for a format hands the attachment straight to the
    // app. Note this is the ONLY thing that setting can do for PDFs: a plugin
    // cannot claim `.pdf` at all (registerExtensions throws on an
    // already-registered extension), so a PDF opened from the file explorer
    // never reaches this view in the first place.
    if (file.extension === "md" && this.getSettings().readers[attachment.extension === "epub" ? "epub" : "pdf"] === "default") {
      const target = resolveBookAttachment(this.app, file, this.getSettings().properties.attachments);
      if (target) {
        await this.leaf.openFile(target);
        return;
      }
    }

    let engine: ReaderEngine;
    try {
      engine = attachment.extension === "epub" ? this.newEpubEngine() : this.newPdfEngine();
      const viewport = root.createDiv({ cls: "ereader-reader__viewport" });
      await engine.open(attachment.path, viewport);
    } catch (error) {
      console.error("[e-reader] failed to open book", error);
      this.clearViewport();
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
    engine.onChange(() => this.updateToolbar());
    this.toolbar?.setVisible(true);

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
    this.announcePosition();
    this.updateToolbar();
    await this.refreshEntries();
  }

  private newPdfEngine(): ReaderEngine {
    const preferences = this.getSettings().reader;
    return createPdfEngine(this.app, {
      scale: preferences.pdfScale,
      spread: preferences.pdfSpread,
      adaptToTheme: preferences.pdfAdaptToTheme,
      onPreferencesChanged: (next) => {
        const reader = this.getSettings().reader;
        reader.pdfScale = next.scale;
        reader.pdfSpread = next.spread;
        reader.pdfAdaptToTheme = next.adaptToTheme;
        this.saveSettings();
      },
    });
  }

  private newEpubEngine(): ReaderEngine {
    const preferences = this.getSettings().reader;
    return createEpubEngine(this.app, {
      textScale: preferences.epubTextScale,
      flow: preferences.epubFlow,
      onPreferencesChanged: (next) => {
        const reader = this.getSettings().reader;
        reader.epubTextScale = next.textScale;
        reader.epubFlow = next.flow;
        this.saveSettings();
      },
    });
  }

  /**
   * The open book's own table of contents, empty when it declares none. The
   * outline pane falls back to the note's headings in that case (FR-025a).
   */
  async outline(): Promise<OutlineNode[]> {
    if (this.cachedOutline) return this.cachedOutline;
    const engine = this.engine;
    if (!engine) return [];
    try {
      const nodes = await engine.outline();
      this.cachedOutline = nodes;
      return nodes;
    } catch (error) {
      console.error("[e-reader] failed to read the book's contents", error);
      return [];
    }
  }

  /** Where the reader is now, for panes that indicate the current section. */
  currentLocator(): Locator | null {
    return this.engine?.currentLocator() ?? null;
  }

  private announcePosition(): void {
    if (!this.file) return;
    this.events.emitPosition(this.file.path, this.currentLocator());
  }

  /** Scrolls this reader to `locator`. Used by the sidebar panes. */
  async goToLocator(locator: Locator): Promise<void> {
    try {
      await this.engine?.goTo(locator);
      this.announcePosition();
      this.updateToolbar();
    } catch (error) {
      console.error("[e-reader] failed to navigate to a locator", error);
    }
  }

  /** The current selection in the rendered document, or null. */
  selection(): EngineSelection | null {
    return this.engine?.getSelection() ?? null;
  }

  // ------------------------------------------------------------- toolbar

  private updateToolbar(): void {
    const engine = this.engine;
    if (!this.toolbar) return;
    if (!engine) {
      this.toolbar.setVisible(false);
      return;
    }
    const pages = engine.pageState();
    this.toolbar.update(
      toolbarState({
        pages,
        scale: engine.scale(),
        highlightsShown: this.getSettings().reader.showHighlights,
        bookmarked: this.currentBookmark() !== null,
      }),
    );
  }

  private async zoom(direction: 1 | -1): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    await engine.setScale(stepScale(engine.scale(), direction));
    this.updateToolbar();
  }

  private async goToPage(page: number): Promise<void> {
    await this.engine?.goToPage(page);
    this.announcePosition();
    this.updateToolbar();
  }

  // ---------------------------------------------------------- highlights

  /**
   * Re-reads the book note's entries and applies them: highlights are painted
   * into the document (when the toolbar's toggle is on) and bookmarks feed the
   * bookmark button's filled state. The note is the store, so this runs on
   * every metadata change rather than caching across edits.
   */
  private async refreshEntries(): Promise<void> {
    const note = this.bookNote();
    const engine = this.engine;
    if (!note || !engine) {
      this.bookmarks = [];
      this.lastEntrySignature = null;
      this.updateToolbar();
      return;
    }
    let entries: Entry[] = [];
    try {
      entries = (await listEntries(this.app, note)).entries;
    } catch (error) {
      console.error("[e-reader] failed to read the book note's entries", error);
      return;
    }
    if (this.engine !== engine) return; // the book changed while we read

    const showHighlights = this.getSettings().reader.showHighlights;
    const signature = `${showHighlights}\u0000${entries
      .map((entry) => [entry.id, entry.type, entry.exact, entry.anchor.prefix ?? "", entry.anchor.suffix ?? ""].join("\u0001"))
      .join("\u0002")}`;
    if (signature === this.lastEntrySignature) return;
    this.lastEntrySignature = signature;

    this.bookmarks = entries.filter((entry) => entry.type === BOOKMARK_TYPE);

    const painted: PaintedHighlight[] = showHighlights
      ? entries
          .filter((entry) => entry.type !== BOOKMARK_TYPE && entry.exact !== "")
          .map((entry) => ({
            id: entry.id,
            type: entry.type,
            exact: entry.exact,
            ...(entry.anchor.prefix === undefined ? {} : { prefix: entry.anchor.prefix }),
            ...(entry.anchor.suffix === undefined ? {} : { suffix: entry.anchor.suffix }),
            ...(entry.anchor.hint === undefined ? {} : { hint: entry.anchor.hint }),
          }))
      : [];
    try {
      await engine.paintHighlights(painted);
    } catch (error) {
      console.error("[e-reader] failed to paint saved highlights", error);
    }
    this.updateToolbar();
  }

  private async toggleHighlights(): Promise<void> {
    const reader = this.getSettings().reader;
    reader.showHighlights = !reader.showHighlights;
    this.saveSettings();
    await this.refreshEntries();
  }

  // ----------------------------------------------------------- bookmarks

  /** The bookmark sitting on the page the reader is looking at, if any. */
  private currentBookmark(): Entry | null {
    const engine = this.engine;
    const here = engine?.pageState()?.current;
    if (!engine || here === undefined) return null;
    for (const entry of this.bookmarks) {
      const hint = entry.anchor.hint;
      if (hint && engine.pageNumberFor(hint) === here) return entry;
    }
    return null;
  }

  private async toggleBookmark(): Promise<void> {
    const note = this.bookNote();
    if (!note) {
      new Notice("E-Reader: bookmarks are stored in a book note — open this book from your library.");
      return;
    }
    const existing = this.currentBookmark();
    if (!existing) {
      await this.createEntry(BOOKMARK_TYPE, null);
      return;
    }
    try {
      await removeEntry(this.app, note, existing.id);
    } catch (error) {
      console.error("[e-reader] failed to remove a bookmark", error);
      new Notice("E-Reader: could not remove that bookmark — see the console.");
    }
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
