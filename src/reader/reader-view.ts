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
import { addEntry, listEntries, removeEntry, setEntryType } from "../annotations/store";
import type { Entry } from "../annotations/entry";
import type { ReaderEvents } from "../core/reader-events";
import { describeAttachmentLookup, resolveBookAttachment, resolveBookAttachmentPath } from "../core/attachment";
import { isBookNote } from "../core/book-note";
import { parseLocator, serializeLocator } from "../core/locator";
import { RESERVED_ENTRY_TYPE, type Locator } from "../core/types";
import type { Settings } from "../settings/settings-model";
import { createEpubEngine } from "./epub/adapter";
import type { DisplayOption, EngineSelection, OutlineNode, PaintedHighlight, ReaderEngine } from "./engine";
import { createPdfEngine } from "./pdf/adapter";
import { type ReadingPosition, positionChanged, shouldFlushNow } from "./position";
import { clampProgress } from "./progress";
import { highlightColor } from "./highlight-style";
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
  /** The book note's entries, as last read. The context menu looks one up by
   * id when the reader right-clicks a painted highlight, and the bookmark
   * button reads the bookmarks out of it. */
  private entries: Entry[] = [];
  /**
   * Signature of the entries last applied. The reader writes progress into
   * the book note's frontmatter every couple of seconds, and every one of
   * those writes fires `metadataCache.changed` — repainting the whole book
   * each time, for a change that cannot possibly have touched an entry.
   */
  private lastEntrySignature: string | null = null;
  /**
   * Whether a completed drag becomes a highlight straight away. Deliberately
   * NOT persisted: a reader that comes back to an armed book and silently
   * turns its first drag into a note has been ambushed, and re-arming costs
   * one click.
   */
  private highlightMode = false;
  /**
   * The selection as it stood when the highlight button was pressed. Pressing
   * a button outside the text collapses the selection, so by the time the
   * click handler runs there may be nothing left to read.
   */
  private capturedSelection: EngineSelection | null = null;

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
      displayOptions: () => this.displayOptions(),
      highlightOrToggleMode: () => void this.highlightOrToggleMode(),
      captureSelection: () => {
        this.capturedSelection = this.selection();
      },
      annotationTypes: () => this.getSettings().annotationTypes,
      chooseHighlightType: (name) => {
        this.getSettings().reader.activeAnnotationType = name;
        this.saveSettings();
        // Choosing a type is how most readers will start highlighting, so it
        // arms rather than making them click the button as well.
        this.setHighlightMode(true);
      },
      toggleBookmark: () => void this.toggleBookmark(),
      find: (query) => this.engine?.find({ query, caseSensitive: false, highlightAll: true }),
      findNext: (backwards) => this.engine?.findNext(backwards),
      findClose: () => this.engine?.findClose(),
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
    this.entries = [];
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

  /**
   * The book note this reader is reading, or null when there is none to write
   * to — a bare `.epub` opened from the file explorer, or a markdown note the
   * reader has not marked as a book.
   *
   * Everything that writes goes through here, so the marker property is what
   * keeps this plugin out of notes that are not books. Rendering is NOT gated
   * on it: a note with a readable attachment still opens and reads perfectly
   * well, it simply does not get progress or highlights written into it.
   */
  private bookNote(): TFile | null {
    const file = this.file;
    if (!file || file.extension !== "md") return null;
    const properties = this.getSettings().properties;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return isBookNote(frontmatter, properties.marker, properties.markerValue) ? file : null;
  }

  /** Explains a refused write in terms of the property the reader configured. */
  private notABookNoteNotice(): string {
    const properties = this.getSettings().properties;
    return `E-Reader: this note is not marked as a book (${properties.marker}: ${properties.markerValue}), so nothing was saved to it.`;
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
    this.entries = [];
    this.lastEntrySignature = null;
    this.highlightMode = false;
    this.capturedSelection = null;
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
    engine.onSelectionEnd(() => void this.onSelectionEnd());
    engine.onChange(() => this.updateToolbar());
    engine.onFindState((state) => this.toolbar?.updateFind(state));
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
      fit: preferences.pdfFit,
      spread: preferences.pdfSpread,
      adaptToTheme: preferences.pdfAdaptToTheme,
      onPreferencesChanged: (next) => {
        const reader = this.getSettings().reader;
        reader.pdfScale = next.scale;
        reader.pdfFit = next.fit;
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

  /**
   * The engine's own options plus the reader-level ones. Whether saved
   * highlights are drawn is a property of the view, not of the format, so it
   * is appended here rather than duplicated in both adapters.
   */
  private displayOptions(): DisplayOption[] {
    const engineOptions = this.engine?.displayOptions() ?? [];
    return [
      ...engineOptions,
      {
        section: "appearance",
        id: "show-highlights",
        label: "Show saved highlights",
        icon: "highlighter",
        checked: this.getSettings().reader.showHighlights,
        apply: () => this.toggleHighlights(),
      },
    ];
  }

  private updateToolbar(): void {
    const engine = this.engine;
    if (!this.toolbar) return;
    if (!engine) {
      this.toolbar.setVisible(false);
      return;
    }
    const settings = this.getSettings();
    const activeType = this.activeType();
    this.toolbar.update(
      toolbarState({
        pages: engine.pageState(),
        scale: engine.scale(),
        highlightMode: this.highlightMode,
        activeType,
        activeColor: activeType === "" ? "" : highlightColor(settings.annotationTypes, activeType),
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
      this.entries = [];
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
    const palette = this.getSettings()
      .annotationTypes.map((type) => `${type.name}:${type.color}`)
      .join(",");
    const signature = `${showHighlights}\u0000${palette}\u0000${entries
      .map((entry) => [entry.id, entry.type, entry.exact, entry.anchor.prefix ?? "", entry.anchor.suffix ?? ""].join("\u0001"))
      .join("\u0002")}`;
    if (signature === this.lastEntrySignature) return;
    this.lastEntrySignature = signature;

    this.entries = entries;

    const painted: PaintedHighlight[] = showHighlights
      ? entries
          .filter((entry) => entry.type !== BOOKMARK_TYPE && entry.exact !== "")
          .map((entry) => ({
            id: entry.id,
            type: entry.type,
            exact: entry.exact,
            color: highlightColor(this.getSettings().annotationTypes, entry.type),
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

  /** The configured type highlight mode writes, or empty when there are none. */
  private activeType(): string {
    const settings = this.getSettings();
    const active = settings.reader.activeAnnotationType;
    if (active !== "" && settings.annotationTypes.some((type) => type.name === active)) return active;
    return settings.annotationTypes[0]?.name ?? "";
  }

  /**
   * The highlight button does whichever of its two jobs the moment calls for:
   * with text selected it highlights that, and with nothing selected it arms
   * the mode so a drag highlights directly. One button, because on a
   * touchscreen there is no drag-release to trigger on — a long-press
   * selection settles after the touch ends — so "select, then tap" is the
   * only gesture that works there.
   */
  private async highlightOrToggleMode(): Promise<void> {
    const selection = this.selection() ?? this.capturedSelection;
    this.capturedSelection = null;
    const type = this.activeType();
    if (selection && selection.exact !== "" && type !== "") {
      this.clearSelection();
      await this.createEntry(type, selection);
      return;
    }
    this.setHighlightMode(!this.highlightMode);
  }

  private setHighlightMode(on: boolean): void {
    this.highlightMode = on && this.activeType() !== "";
    if (on && this.activeType() === "") {
      new Notice("E-Reader: add a highlight type in settings before using highlight mode.");
    }
    this.updateToolbar();
  }

  /**
   * A drag finished inside the book. In highlight mode that becomes a
   * highlight there and then — no menu — and the selection is cleared so the
   * same words cannot be highlighted twice by an idle second release.
   */
  private async onSelectionEnd(): Promise<void> {
    if (!this.highlightMode) return;
    const type = this.activeType();
    if (type === "") return;
    const selection = this.selection();
    if (!selection || selection.exact === "") return;
    this.clearSelection();
    await this.createEntry(type, selection);
  }

  private clearSelection(): void {
    // The selection lives in whichever document the engine rendered into —
    // an EPUB's iframe, or the host document for a PDF — and `activeWindow`
    // is not necessarily either, so the engine's own root is asked instead.
    this.engine?.clearSelection();
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
    for (const entry of this.entries) {
      if (entry.type !== BOOKMARK_TYPE) continue;
      const hint = entry.anchor.hint;
      if (hint && engine.pageNumberFor(hint) === here) return entry;
    }
    return null;
  }

  private async toggleBookmark(): Promise<void> {
    const note = this.bookNote();
    if (!note) {
      new Notice(this.notABookNoteNotice());
      return;
    }
    const existing = this.currentBookmark();
    if (!existing) {
      await this.createEntry(BOOKMARK_TYPE, null);
      return;
    }
    await this.deleteEntry(note, existing);
  }

  /**
   * The entry whose painted highlight sits under `position`, or null.
   *
   * Both engines put their overlay in the HOST document — a PDF's boxes are
   * children of the page element, and epub.js's marks-pane appends its SVG
   * beside the iframe rather than inside it — so both are reachable from here
   * and both report client rects in the same coordinate space the context
   * menu was given. Hit-testing is by rect rather than `elementFromPoint`
   * because both overlays are deliberately `pointer-events: none`, and must
   * stay that way so they never swallow a text selection.
   */
  private entryAt(position: { x: number; y: number }): Entry | null {
    const root = this.contentRoot;
    if (!root) return null;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(".ereader-hl[data-id]"))) {
      const rect = el.getBoundingClientRect();
      if (position.x < rect.left || position.x > rect.right) continue;
      if (position.y < rect.top || position.y > rect.bottom) continue;
      const id = el.dataset["id"];
      const entry = this.entries.find((candidate) => candidate.id === id);
      if (entry) return entry;
    }
    return null;
  }

  private showAnnotationMenu(position: { x: number; y: number }): void {
    const menu = new Menu();
    const note = this.bookNote();
    const types = this.getSettings().annotationTypes;

    // Right-clicking something that already exists should act on THAT thing.
    // Offering "highlight this selection" on top of a highlight, or "add a
    // bookmark" on a page that already has one, is the menu ignoring what is
    // in front of it.
    const existing = this.entryAt(position);
    if (existing && note) {
      this.addEntryItems(menu, note, existing, types);
      menu.showAtPosition(position);
      return;
    }

    const selection = this.selection();
    if (selection) {
      for (const type of types) {
        menu.addItem((item) =>
          item
            .setTitle(`Highlight — ${type.name}`)
            .setIcon("highlighter")
            .onClick(() => void this.createEntry(type.name, selection)),
        );
      }
      menu.addSeparator();
    }

    const bookmark = this.currentBookmark();
    if (bookmark && note) {
      menu.addItem((item) =>
        item
          .setTitle("Remove bookmark")
          .setIcon("bookmark-minus")
          .onClick(() => void this.deleteEntry(note, bookmark)),
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle("Add bookmark here")
          .setIcon("bookmark")
          .onClick(() => void this.createEntry(BOOKMARK_TYPE, null)),
      );
    }
    menu.showAtPosition(position);
  }

  /** Actions on one existing entry: recolour it, copy it, or take it away. */
  private addEntryItems(menu: Menu, note: TFile, entry: Entry, types: readonly { name: string }[]): void {
    const isBookmark = entry.type === BOOKMARK_TYPE;
    if (!isBookmark) {
      for (const type of types) {
        if (type.name === entry.type) continue;
        menu.addItem((item) =>
          item
            .setTitle(`Change to — ${type.name}`)
            .setIcon("highlighter")
            .onClick(() => void this.changeEntryType(note, entry, type.name)),
        );
      }
      menu.addItem((item) =>
        item
          .setTitle("Copy text")
          .setIcon("copy")
          .onClick(() => void navigator.clipboard.writeText(entry.exact)),
      );
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle(isBookmark ? "Remove bookmark" : "Delete highlight")
        .setIcon("trash-2")
        .onClick(() => void this.deleteEntry(note, entry)),
    );
  }

  private async changeEntryType(note: TFile, entry: Entry, type: string): Promise<void> {
    try {
      await setEntryType(this.app, note, entry.id, type);
    } catch (error) {
      console.error("[e-reader] failed to change an entry's type", error);
      new Notice("E-Reader: could not change that highlight — see the console.");
    }
  }

  private async deleteEntry(note: TFile, entry: Entry): Promise<void> {
    try {
      await removeEntry(this.app, note, entry.id);
    } catch (error) {
      console.error("[e-reader] failed to remove an entry", error);
      new Notice("E-Reader: could not remove that entry — see the console.");
    }
  }

  /**
   * Writes a highlight (or, with a null selection, a bookmark) into the book
   * note. This is a reader action, so it is one of the writes FR-037a allows.
   */
  async createEntry(type: string, selection: EngineSelection | null): Promise<void> {
    const note = this.bookNote();
    if (!note) {
      new Notice(this.notABookNoteNotice());
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
    const raw = cache?.frontmatter?.[this.getSettings().properties.lastRead];
    return typeof raw === "string" ? parseLocator(raw) : null;
  }

  private currentPosition(): ReadingPosition | null {
    if (!this.engine) return null;
    const locator = this.engine.currentLocator();
    if (!locator) return null;
    return { progress: clampProgress(this.engine.progress()), locator: serializeLocator(locator) };
  }

  /**
   * Writes progress and position to the book note's frontmatter, under the
   * reader's CONFIGURED names (FR-006) — these were hardcoded, so renaming
   * either in settings left the reader writing one key while the library
   * read another, and progress silently stopped updating. Only those two
   * keys are touched (FileManager.processFrontMatter mutates the parsed
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
      const properties = this.getSettings().properties;
      await this.app.fileManager.processFrontMatter(bookNote, (frontmatter: Record<string, unknown>) => {
        frontmatter[properties.progress] = current.progress;
        frontmatter[properties.lastRead] = current.locator;
      });
    } catch (error) {
      console.error("[e-reader] failed to write reading position", error);
    }
  }
}
