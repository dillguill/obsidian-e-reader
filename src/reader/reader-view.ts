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
import { FileView, Menu, Notice, Platform, Scope, TFile, debounce, setIcon, setTooltip } from "obsidian";
import { addEntry, fillSections, foldHighlightNotes, listEntries, migrateBookmarks, removeEntry, setEntryType } from "../annotations/store";
import { linksToBook } from "../annotations/highlight-notes";
import { addCopyItems } from "../annotations/entry-menu";
import { activeRowIndex, rowsFromOutline } from "../sidebar/outline-model";
import type { Entry } from "../annotations/entry";
import type { ReaderEvents } from "../core/reader-events";
import { describeAttachmentLookup, resolveBookAttachment, resolveBookAttachmentPath } from "../core/attachment";
import { isBookNote } from "../core/book-note";
import { compareLocators, parseLocator, serializeLocator } from "../core/locator";
import { RESERVED_ENTRY_TYPE, type Locator } from "../core/types";
import type { Settings } from "../settings/settings-model";
import { createEpubEngine } from "./epub/adapter";
import type { DisplayOption, EngineSelection, OutlineNode, PaintedHighlight, ReaderEngine } from "./engine";
import { createPdfEngine } from "./pdf/adapter";
import { type ReadingPosition, furthestOf, jumpTarget, positionChanged, shouldFlushNow } from "./position";
import { clampProgress } from "./progress";
import { highlightColor } from "./highlight-style";
import { isTypingTarget, keyAction } from "./keys";
import { type PopupPlacement, SelectionPopup } from "./selection-popup";
import { ReaderToolbar } from "./toolbar";
import { progressLabel, targetFromInput, toolbarState } from "./toolbar-model";
import { MAX_SCALE, MIN_SCALE, stepScale } from "./zoom";
import { AppearancePanel, type PanelRow } from "./appearance-panel";
import { SearchPanel } from "./search-panel";
import type { SearchHit } from "./search";
import {
  BOOK_FONTS,
  FONT_LABELS,
  LINE_SPACINGS,
  LINE_SPACING_LABELS,
  MARGINS,
  MARGIN_LABELS,
  READING_THEMES,
  type ReadingTheme,
  THEME_LABELS,
  type Typography,
} from "./typography";
import { ScrollChrome } from "./gestures";
import { rememberPdfView } from "../settings/settings-model";
import {
  type ChapterStart,
  adjacentChapter,
  chapterAt,
  chapterFraction,
  chapterTicks,
  formatDuration,
  nextPace,
  unitsLeft,
} from "./reading-time";

export const READER_VIEW_TYPE = "ereader-reader";

/** What the reading-settings panel calls each group of the engine's options. */
const OPTION_GROUP_LABELS: Record<DisplayOption["section"], string> = {
  zoom: "Fit",
  spread: "Pages",
  layout: "Layout",
  appearance: "",
};

/**
 * The engines describe their options as a flat list of checked items in
 * sections. In the panel, a section of several items is one choice among
 * them, and an item on its own is a switch.
 */
function optionRows(options: readonly DisplayOption[]): PanelRow[] {
  const rows: PanelRow[] = [];
  const sections = [...new Set(options.map((option) => option.section))];
  for (const section of sections) {
    const group = options.filter((option) => option.section === section);
    if (group.length === 1 || section === "appearance") {
      for (const option of group) {
        rows.push({ kind: "toggle", label: option.label, value: option.checked, onChange: () => option.apply() });
      }
      continue;
    }
    rows.push({
      kind: "choice",
      label: OPTION_GROUP_LABELS[section],
      options: group.map((option) => ({ value: option.id, label: option.label })),
      // A PDF stepped off every fit by the zoom control has none selected.
      value: group.find((option) => option.checked)?.id ?? "",
      onChange: (id) => group.find((option) => option.id === id)?.apply(),
    });
  }
  return rows;
}

export interface ReaderViewState {
  /** The book note's path. FileView reads this and calls `loadFile` itself. */
  file?: string;
  /** Accepted for workspaces saved before `file` became the source of truth. */
  bookNotePath?: string;
  [key: string]: unknown;
}

const POSITION_FLUSH_INTERVAL_MS = 2000;
/**
 * How often a touchscreen checks for a selection the popup has not opened
 * for. iOS takes a long press over and the page hears neither the release
 * nor, reliably, the selection changing, so on a touchscreen the popup does
 * not wait for an event at all.
 */
const TOUCH_SELECTION_POLL_MS = 250;
const BOOKMARK_TYPE = RESERVED_ENTRY_TYPE;
/**
 * A tap this soon after a selection was last seen is the reader dismissing
 * that selection, not asking for the toolbar. The touch poll sees a live
 * selection at least this often, so the margin is comfortable.
 */
const SELECTION_DISMISS_MS = 600;
/** The middle share of the page whose tap shows or hides the toolbar on a touchscreen. */
const CHROME_TAP_ZONE = 1 / 3;
/** The painted mark on the search result being looked at. */
const SEARCH_MARK_ID = "ereader-search-hit";
const SEARCH_MARK_COLOR = "#ff9f1a";
/** On a desktop with auto-hide on, the bars hide after the pointer has been still this long. */
const CHROME_IDLE_MS = 2500;
/** The learned reading pace is saved this long after it last changed. */
const PACE_SAVE_DELAY_MS = 30_000;
const THEME_CLASSES: Record<ReadingTheme, string> = {
  auto: "",
  light: "ereader-theme-light",
  sepia: "ereader-theme-sepia",
  dark: "ereader-theme-dark",
};

/** Space on a button or switch presses it; it is not the reader asking for the next page. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("button, [role='button'], [role='switch'], [role='radio']") !== null;
}

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
  /** The bar of highlight swatches that opens over a selection. */
  private popup: SelectionPopup | null = null;
  /** When a selection was last seen in the book, for telling a dismissing tap apart. */
  private selectionSeenAt = 0;
  private search: SearchPanel | null = null;
  private appearance: AppearancePanel | null = null;
  /** The search result being looked at, painted over the page alongside the highlights. */
  private searchMark: PaintedHighlight | null = null;
  private footer: {
    el: HTMLElement;
    chapterEl: HTMLElement;
    chapterLeftEl: HTMLElement;
    bookEl: HTMLElement;
    barEl: HTMLElement;
    ticksEl: HTMLElement;
    /** The chapter list the ticks were last drawn for. */
    ticksFor: ChapterStart[] | null;
  } | null = null;
  /** Which engine is open, for the pace the time-left estimates use. */
  private format: "epub" | "pdf" | null = null;
  /** The contents placed on the page/location scale, rebuilt when that scale changes. */
  private chapterStarts: { total: number; starts: ChapterStart[] } | null = null;
  /** Where the reader last stood, and when, for learning their pace from page turns. */
  private paceAnchor: { unit: number; at: number } | null = null;
  /**
   * The one floating chip over the page: on opening, the offer to jump on to
   * the furthest place read; after a jump, the way back to where the reader
   * was. Both are the same kind of thing — a place to go — so they share a
   * look and a slot, and a jump replaces the offer with the way back.
   */
  private chip: { el: HTMLElement; kind: "resume" | "back"; target: Locator } | null = null;
  /** A jump's starting point, until the jump is seen to have landed somewhere else. */
  private pendingBack: { target: Locator; at: number } | null = null;
  private readonly savePace = debounce(() => this.saveSettings(), PACE_SAVE_DELAY_MS, true);
  /** On a touchscreen, the bars follow the direction the page is scrolled. */
  private readonly scrollChrome = new ScrollChrome();
  /** The scroller `scrollChrome` last measured, so a different one starts it afresh. */
  private scrollChromeEl: EventTarget | null = null;
  /** The desktop's countdown to hiding the bars. */
  private idleTimer: number | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => Settings,
    private readonly saveSettings: () => void,
    private readonly events: ReaderEvents,
    private readonly attachFile: (note: TFile) => Promise<boolean>,
    private readonly openContents: () => void,
    private readonly openHighlights: () => void,
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
      goToPage: (value) => void this.goToPage(value),
      toggleBookmark: () => void this.toggleBookmark(),
      turnPage: (direction) => void this.turnPage(direction),
      openContents: () => this.openContents(),
      openHighlights: () => this.openHighlights(),
      toggleSearch: () => this.toggleSearch(),
      toggleAppearance: (anchorEl) => {
        this.search?.hide();
        this.measureChrome();
        this.appearance?.toggle(() => this.appearanceRows(), anchorEl);
      },
    });

    this.search = new SearchPanel(this.contentRoot, this, {
      // The contents first: results are labelled with their chapter, and an
      // EPUB's contents are read from the same sections the search walks.
      search: async (query, handlers, signal) => {
        await this.outline();
        if (!signal.aborted) await this.engine?.search(query, handlers, signal);
      },
      label: (hit) => this.searchLabel(hit),
      open: (hit) => void this.openSearchHit(hit),
      closed: () => void this.clearSearchMark(),
    });
    this.appearance = new AppearancePanel(this.contentRoot, this);
    this.footer = this.buildFooter(this.contentRoot);
    this.toolbar.setVisible(false);
    this.watchChrome(this.contentRoot);

    this.popup = new SelectionPopup(this.contentRoot, this, {
      highlight: (type, selection) => void this.highlightFromPopup(type, selection),
      copy: (selection) => {
        void navigator.clipboard.writeText(selection.exact);
        this.closePopup(false);
      },
    });
    // Scrolling moves the selection out from under the popup. `scroll` does
    // not bubble, so it is caught on the way down instead.
    this.registerDomEvent(
      this.contentRoot,
      "scroll",
      (event: Event) => {
        this.repositionPopup();
        this.followScroll(event.target);
      },
      { capture: true },
    );
    if (Platform.isMobile) {
      this.registerInterval(window.setInterval(() => this.pollTouchSelection(), TOUCH_SELECTION_POLL_MS));
    }

    // Keys pressed in the host document — a PDF, or the pane around an EPUB
    // — reach the view through its Scope while it is the active leaf. Presses
    // inside an EPUB's iframes arrive through the engine instead.
    const scope = this.scope ?? (this.scope = new Scope(this.app.scope));
    // Any modifiers: keyAction decides, so Shift-arrows (chapters) and
    // Shift-Space reach it too, and a press it does not take carries on.
    for (const key of ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Escape", " "]) {
      scope.register(null, key, (event) => (this.handleKey(event) ? false : true));
    }
    scope.register(["Mod"], "f", (event) => (this.handleKey(event) ? false : true));

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
        const book = this.bookNote();
        if (!book) return;
        // A highlight note of this book counts too: its entries are this book's.
        if (file === book || linksToBook(this.app, file, book, this.getSettings().highlights.properties.book)) {
          void this.refreshEntries();
        }
      }),
    );
    // An EPUB renders inside iframes that inherit none of the vault's CSS, so
    // a theme switch has to be pushed into them.
    this.registerEvent(this.app.workspace.on("css-change", () => this.engine?.refreshTheme()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncAppChrome()));
    this.register(() => this.containerEl.doc.body.removeClass("ereader-immersive-epub", "ereader-immersive-pdf"));
    // A PDF's remembered zoom follows it when it is renamed or moved.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const reader = this.getSettings().reader;
        const view = reader.pdfBooks[oldPath];
        if (!view) return;
        delete reader.pdfBooks[oldPath];
        reader.pdfBooks[file.path] = view;
        this.saveSettings();
      }),
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
    this.closePopup(false);
    this.resetBookChrome();
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
    this.syncAppChrome();
  }

  override async onClose(): Promise<void> {
    this.closePopup(false);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.savePace.run();
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
    this.closeChip();
    this.viewportEl()?.remove();
    this.contentRoot?.querySelector(".ereader-reader__empty")?.remove();
  }

  private renderNoFile(root: HTMLElement, note: TFile): void {
    const box = root.createDiv({ cls: "ereader-reader__empty ereader-reader__no-file" });
    setIcon(box.createDiv({ cls: "ereader-reader__no-file-icon" }), "book-dashed");
    box.createDiv({ cls: "ereader-reader__no-file-title", text: "No file yet" });
    box.createDiv({
      cls: "ereader-reader__no-file-detail",
      text: "This book is on your wishlist. Add its EPUB or PDF to start reading; the note keeps everything it already has.",
    });
    const actions = box.createDiv({ cls: "ereader-reader__no-file-actions" });
    const add = actions.createEl("button", { cls: "mod-cta", text: "Add file…" });
    add.addEventListener("click", () => {
      void this.attachFile(note).then((attached) => {
        if (attached && this.file === note) void this.loadBook(note);
      });
    });
    const open = actions.createEl("button", { text: "Open note" });
    open.addEventListener("click", () => void this.leaf.openFile(note, { state: { mode: "source" } }));
  }

  /** Resolves once the book being opened has loaded (or failed to), for callers that need it open. */
  private loading: Promise<void> = Promise.resolve();

  private loadBook(file: TFile): Promise<void> {
    const load = this.loadBookNow(file);
    this.loading = load.catch(() => undefined);
    return load;
  }

  private async loadBookNow(file: TFile): Promise<void> {
    const root = this.contentRoot;
    if (!root) return;
    const token = ++this.loadToken;

    this.engine?.destroy();
    this.engine = null;
    this.cachedOutline = null;
    this.entries = [];
    this.lastEntrySignature = null;
    this.closePopup(false);
    this.toolbar?.setVisible(false);
    root.removeClass("is-immersive");
    root.removeClass("is-epub", "is-pdf");
    this.syncAppChrome();
    this.scrollChrome.reset();
    this.scrollChromeEl = null;
    this.resetBookChrome();
    this.clearViewport();

    // Opening an .epub straight from the file explorer gives us the book
    // itself rather than a note about it; there is nothing to resolve.
    const attachment =
      file.extension === "md"
        ? await resolveBookAttachmentPath(this.app, file, this.getSettings().properties.attachments)
        : { path: file.path, extension: file.extension, name: file.name };

    if (!attachment) {
      // A wishlist book: a note with no file yet. Say so, and offer the way
      // forward, rather than leaving an empty pane.
      console.debug("[e-reader] no attachment\n" + (await describeAttachmentLookup(this.app, file)));
      if (token !== this.loadToken) return;
      this.renderNoFile(root, file);
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
      this.format = attachment.extension === "epub" ? "epub" : "pdf";
      root.addClass(`is-${this.format}`);
      this.applyTheme();
      engine = this.format === "epub" ? this.newEpubEngine() : this.newPdfEngine(file.path);
      const viewport = root.createDiv({ cls: "ereader-reader__viewport" });
      // Above the footer, which lives for the life of the view.
      if (this.footer) root.insertBefore(viewport, this.footer.el);
      // The bars are in place before the page is laid out, so it is laid out
      // once, clear of them.
      this.toolbar?.setVisible(true);
      this.showFooterPlaceholder();
      this.measureChrome();
      // A large book takes a moment to read and lay out; say that it is coming.
      const loading = root.createDiv({ cls: "ereader-reader__loading", attr: { "aria-label": "Opening book" } });
      loading.createDiv({ cls: "ereader-reader__spinner" });
      try {
        await engine.open(attachment.path, viewport);
      } finally {
        loading.remove();
      }
    } catch (error) {
      console.error("[e-reader] failed to open book", error);
      this.clearViewport();
      this.toolbar?.setVisible(false);
      this.footer?.el.hide();
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
    engine.onTap((position) => this.showEntryMenuAt(position));
    engine.onSelectionEnd(() => this.onSelectionEnd());
    engine.onSelectionChange(() => this.onSelectionChange());
    engine.onKeyDown((event) => this.handleKey(event));
    engine.onLinkFollowed(() => this.recordJump());
    engine.onChange(() => {
      this.dropJumpOfferIfReached();
      this.settleBack();
      this.trackPace();
      this.updateToolbar();
      this.repositionPopup();
    });
    this.toolbar?.setVisible(true);
    this.noteActivity();

    const properties = this.getSettings().properties;
    const restored = this.readStoredLocator(file, properties.lastRead);
    if (restored) {
      try {
        await engine.goTo(restored);
      } catch (error) {
        console.error("[e-reader] failed to restore reading position", error);
      }
    }
    const further = jumpTarget(restored, this.readStoredLocator(file, properties.furthestRead));
    if (further) this.offerJump(further);
    this.lastWritten = this.currentPosition();
    this.lastFlushAt = Date.now();
    this.announcePosition();
    this.updateToolbar();
    // The chapter in the footer needs the contents, which for an EPUB means
    // loading every section the contents name — so it arrives when it is ready.
    void this.outline().then(() => {
      if (this.engine === engine) this.updateToolbar();
    });
    if (file.extension === "md") {
      // Bookmarks written into the note before 0.4.0 move to the bookmarks
      // property, highlights betas kept in notes of their own move back into
      // the book note, and older highlights gain their chapter.
      try {
        await migrateBookmarks(this.app, file, this.getSettings());
        await foldHighlightNotes(this.app, file, this.getSettings());
        // Highlights saved before their chapter was recorded get it from this book's contents.
        await fillSections(this.app, file, this.getSettings(), (entry) =>
          entry.anchor.hint ? this.sectionTitle(entry.anchor.hint) : Promise.resolve(undefined),
        );
      } catch (error) {
        console.error("[e-reader] could not bring this book's highlights up to date", error);
      }
    }
    await this.refreshEntries();
  }

  /**
   * A PDF opens at the zoom, fit and spreads it was last read at, and one
   * never opened before at the last ones used on any PDF.
   */
  private newPdfEngine(path: string): ReaderEngine {
    const preferences = this.getSettings().reader;
    const view = preferences.pdfBooks[path] ?? { scale: preferences.pdfScale, fit: preferences.pdfFit, spread: preferences.pdfSpread };
    return createPdfEngine(this.app, {
      scale: view.scale,
      fit: view.fit,
      spread: view.spread,
      onPreferencesChanged: (next) => {
        const reader = this.getSettings().reader;
        reader.pdfScale = next.scale;
        reader.pdfFit = next.fit;
        reader.pdfSpread = next.spread;
        reader.pdfBooks = rememberPdfView(reader.pdfBooks, path, next);
        this.saveSettings();
      },
    });
  }

  private newEpubEngine(): ReaderEngine {
    const preferences = this.getSettings().reader;
    return createEpubEngine(this.app, {
      textScale: preferences.epubTextScale,
      flow: preferences.epubFlow,
      spread: preferences.epubSpread,
      typography: this.typography(),
      onPreferencesChanged: (next) => {
        const reader = this.getSettings().reader;
        reader.epubTextScale = next.textScale;
        reader.epubFlow = next.flow;
        reader.epubSpread = next.spread;
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

  /**
   * Moves to one of this book's entries, for the links highlights carry. The
   * book may still be opening, so this waits for it to finish loading first.
   */
  async goToEntry(id: string): Promise<void> {
    await this.loading;
    const note = this.bookNote();
    if (!note) return;
    const { entries } = await listEntries(this.app, note, this.getSettings());
    const hint = entries.find((entry) => entry.id === id)?.anchor.hint;
    if (hint) await this.goToLocator(hint);
    else new Notice("E-Reader: that highlight is no longer in this book's notes.");
  }

  /**
   * Scrolls this reader to `locator`. Used by the sidebar panes, which are
   * jumps the reader may want to come back from, so the place left behind is
   * offered as "Back" unless `record` is false.
   */
  async goToLocator(locator: Locator, record = true): Promise<void> {
    if (record) this.recordJump();
    this.paceAnchor = null;
    try {
      await this.engine?.goTo(locator);
      this.announcePosition();
      this.updateToolbar();
    } catch (error) {
      console.error("[e-reader] failed to navigate to a locator", error);
    }
    this.settleBack();
    this.pendingBack = null;
  }

  /** The current selection in the rendered document, or null. */
  selection(): EngineSelection | null {
    return this.engine?.getSelection() ?? null;
  }

  // ------------------------------------------------------------- options

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
      ...(Platform.isMobile
        ? []
        : [
            {
              section: "appearance" as const,
              id: "auto-hide-chrome",
              label: "Hide toolbar while reading",
              icon: "eye-off",
              checked: this.getSettings().reader.autoHideChrome,
              apply: () => {
                const reader = this.getSettings().reader;
                reader.autoHideChrome = !reader.autoHideChrome;
                this.saveSettings();
                if (!reader.autoHideChrome) this.setChromeHidden(false);
                this.noteActivity();
              },
            },
          ]),
      {
        section: "appearance",
        id: "show-footer",
        label: "Show time left and progress",
        icon: "clock",
        checked: this.getSettings().reader.showFooter,
        apply: () => {
          const reader = this.getSettings().reader;
          reader.showFooter = !reader.showFooter;
          this.saveSettings();
          this.updateToolbar();
        },
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
    this.toolbar.update(
      toolbarState({
        pages: engine.pageState(),
        bookmarked: this.currentBookmark() !== null,
        progress: engine.progress(),
      }),
    );
    this.toolbar.setPanesAvailable(this.getSettings().panes);
    this.updateFooter();
  }

  /** Steps the zoom (PDF) or text size (EPUB). Used by the toolbar and the zoom commands. */
  async zoom(direction: 1 | -1): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    await engine.setScale(stepScale(engine.scale(), direction));
    this.updateToolbar();
  }

  /** A value typed into the toolbar's box: a page, or a percentage through a reflowable book. */
  private async goToPage(value: number): Promise<void> {
    const engine = this.engine;
    const pages = engine?.pageState();
    if (!engine || !pages) return;
    this.recordJump();
    this.paceAnchor = null;
    await engine.goToPage(targetFromInput(value, pages));
    this.settleBack();
    this.pendingBack = null;
    this.announcePosition();
    this.updateToolbar();
  }

  /** One page forward or back. Used by the arrow keys and the page commands. */
  async turnPage(direction: 1 | -1): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    this.closePopup(false);
    try {
      await engine.turnPage(direction);
    } catch (error) {
      console.error("[e-reader] failed to turn the page", error);
    }
    this.announcePosition();
    this.updateToolbar();
  }

  /** To the start of the next chapter, or of this or the previous one. Used by Shift-arrows and the chapter commands. */
  async goToChapter(direction: 1 | -1): Promise<void> {
    const engine = this.engine;
    const pages = engine?.pageState();
    if (!engine || !pages) return;
    await this.outline();
    const starts = this.chapterStartsFor(engine, pages.total);
    const index = adjacentChapter(starts, pages.current, direction);
    const target = index === null ? null : rowsFromOutline(this.cachedOutline ?? [])[index]?.target;
    if (target?.kind !== "book") return;
    this.closePopup(false);
    await this.goToLocator(target.locator, false);
  }

  /**
   * Applies a key press from either route — the view's Scope or an EPUB's
   * iframe. Returns whether it was taken, so the caller suppresses the
   * default only then.
   */
  private handleKey(event: KeyboardEvent): boolean {
    if (isTypingTarget(event.target)) return false;
    const action = keyAction(event);
    if (action === "next" || action === "prev") {
      void this.turnPage(action === "next" ? 1 : -1);
      return true;
    }
    // A scrolled PDF's own Space, a screenful, reads better than jumping a
    // whole page that may be taller than the pane.
    if ((action === "advance" || action === "retreat") && this.format === "epub" && !isControl(event.target)) {
      void this.turnPage(action === "advance" ? 1 : -1);
      return true;
    }
    // Shift-arrows extend a selection when there is one.
    if ((action === "next-chapter" || action === "prev-chapter") && !this.engine?.getSelection()) {
      void this.goToChapter(action === "next-chapter" ? 1 : -1);
      return true;
    }
    if (action === "search") {
      this.openSearch();
      return true;
    }
    if (action === "dismiss" && this.popup?.current()) {
      this.closePopup(true);
      return true;
    }
    if (action === "dismiss" && this.appearance?.isOpen()) {
      this.appearance.hide();
      return true;
    }
    if (action === "dismiss" && this.search?.isOpen()) {
      this.search.hide();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------ selection popup

  /** Docked on a touchscreen, clear of the platform's own selection menu; beside the selection otherwise. */
  private popupPlacement(): PopupPlacement {
    return Platform.isMobile ? "docked" : "above";
  }

  /**
   * A drag finished inside the book. The selection can settle a moment after
   * the release — a click that collapses it, a double-click that grows it —
   * so it is read on the next tick rather than inside the event.
   */
  private onSelectionEnd(): void {
    window.setTimeout(() => this.openPopupForSelection(), 0);
  }

  /**
   * The selection changed. Cleared, or different from what the popup was
   * opened for, the popup closes at once; a mouse drag re-opens it on
   * release, and a touchscreen's poll re-opens it.
   */
  private onSelectionChange(): void {
    if (this.popup?.isPressed()) return;
    const selection = this.engine?.getSelection() ?? null;
    if (selection) this.selectionSeenAt = Date.now();
    const open = this.popup?.current() ?? null;
    if (!selection || (open && open.exact !== selection.exact)) this.popup?.hide();
  }

  /** Opens the popup for a touch selection it is not already showing. */
  private pollTouchSelection(): void {
    const engine = this.engine;
    const popup = this.popup;
    if (!engine || !popup || popup.isPressed()) return;
    const selection = engine.getSelection();
    const open = popup.current();
    if (selection) this.selectionSeenAt = Date.now();
    if (!selection) {
      if (open) popup.hide();
      return;
    }
    if (open?.exact === selection.exact) return;
    this.openPopupForSelection();
  }

  private openPopupForSelection(): void {
    const engine = this.engine;
    const popup = this.popup;
    if (!engine || !popup) return;
    const selection = engine.getSelection();
    const rect = engine.selectionRect();
    if (!selection || selection.exact === "" || !rect) {
      popup.hide();
      return;
    }
    // A file that is not a book note cannot take highlights; Copy still works.
    const types = this.bookNote() ? this.getSettings().annotationTypes : [];
    popup.show(selection, rect, types, this.popupPlacement());
  }

  private repositionPopup(): void {
    if (!this.popup?.current()) return;
    this.popup.reposition(this.engine?.selectionRect() ?? null, this.popupPlacement());
  }

  /** Closes the popup, and with `clearSelection` the selection it was open for too. */
  private closePopup(clearSelection: boolean): void {
    if (clearSelection && this.popup?.current()) this.clearSelection();
    this.popup?.hide();
  }

  /**
   * A swatch in the popup. The type chosen is remembered as the one the
   * "Highlight selection" command writes, so a hotkey repeats the last
   * choice made by hand.
   */
  private async highlightFromPopup(type: string, selection: EngineSelection): Promise<void> {
    this.closePopup(true);
    const reader = this.getSettings().reader;
    if (reader.activeAnnotationType !== type) {
      reader.activeAnnotationType = type;
      this.saveSettings();
    }
    await this.createEntry(type, selection);
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
      // A bare book file has no highlights, but a search result is still marked.
      if (engine) await engine.paintHighlights(this.searchMark ? [this.searchMark] : []).catch(() => undefined);
      this.updateToolbar();
      return;
    }
    let entries: Entry[] = [];
    try {
      entries = (await listEntries(this.app, note, this.getSettings())).entries;
    } catch (error) {
      console.error("[e-reader] failed to read the book note's entries", error);
      return;
    }
    if (this.engine !== engine) return; // the book changed while we read

    const showHighlights = this.getSettings().reader.showHighlights;
    const palette = this.getSettings()
      .annotationTypes.map((type) => `${type.name}:${type.color}`)
      .join(",");
    const mark = this.searchMark;
    const markSignature = mark ? `${mark.exact}\u0001${mark.prefix ?? ""}\u0001${JSON.stringify(mark.hint ?? null)}` : "";
    const signature = `${showHighlights}\u0000${palette}\u0000${markSignature}\u0000${entries
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
    if (mark) painted.push(mark);
    try {
      await engine.paintHighlights(painted);
    } catch (error) {
      console.error("[e-reader] failed to paint saved highlights", error);
    }
    this.updateToolbar();
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

  // -------------------------------------------------------------- search

  private openSearch(): void {
    if (!this.engine) return;
    this.appearance?.hide();
    // Results are labelled with their chapter, which needs the contents.
    void this.outline();
    this.measureChrome();
    this.search?.open();
  }

  private toggleSearch(): void {
    if (this.search?.isOpen()) this.search.hide();
    else this.openSearch();
  }

  /** `Page 12` for a PDF; the chapter for an EPUB, whose locations mean nothing to a reader. */
  private searchLabel(hit: SearchHit): string {
    if (hit.locator.kind === "pdf") return `Page ${hit.locator.page}`;
    return this.chapterTitleAt(hit.locator) ?? "";
  }

  private chapterTitleAt(locator: Locator): string | null {
    if (!this.cachedOutline) return null;
    const rows = rowsFromOutline(this.cachedOutline);
    return rows[activeRowIndex(rows, locator)]?.label.trim() || null;
  }

  private async openSearchHit(hit: SearchHit): Promise<void> {
    this.recordJump();
    this.searchMark = {
      id: SEARCH_MARK_ID,
      type: "search",
      exact: hit.exact,
      prefix: hit.prefix,
      suffix: hit.suffix,
      hint: hit.locator,
      color: SEARCH_MARK_COLOR,
    };
    await this.goToLocator(hit.locator, false);
    await this.repaint();
    // A PDF locator only names the page; the mark says where on it.
    if (hit.locator.kind === "pdf") this.scrollMarkIntoView();
  }

  private async clearSearchMark(): Promise<void> {
    if (!this.searchMark) return;
    this.searchMark = null;
    await this.repaint();
  }

  private async repaint(): Promise<void> {
    this.lastEntrySignature = null;
    await this.refreshEntries();
  }

  /** The page may still be drawing, and is painted as it finishes, so this looks for a moment. */
  private scrollMarkIntoView(attempt = 0): void {
    const mark = this.contentRoot?.querySelector<HTMLElement>(`.ereader-hl[data-id="${SEARCH_MARK_ID}"]`);
    if (mark) {
      mark.scrollIntoView({ block: "center" });
      return;
    }
    if (attempt < 10) window.setTimeout(() => this.scrollMarkIntoView(attempt + 1), 100);
  }

  // ---------------------------------------------------------- appearance

  private typography(): Typography {
    const reader = this.getSettings().reader;
    return {
      font: reader.epubFont,
      lineSpacing: reader.epubLineSpacing,
      margins: reader.epubMargins,
      justify: reader.epubJustify,
      hyphenate: reader.epubHyphenate,
    };
  }

  /**
   * The reading theme is a set of colour variables on the reader's root (see
   * styles.css), which the toolbar, the panels and a PDF's page filter read
   * directly. An EPUB's sections are iframes and read them once, so they are
   * restyled too.
   */
  private applyTheme(): void {
    const root = this.contentRoot;
    if (!root) return;
    const theme = this.getSettings().reader.readingTheme;
    for (const cls of Object.values(THEME_CLASSES)) if (cls !== "") root.removeClass(cls);
    if (THEME_CLASSES[theme] !== "") root.addClass(THEME_CLASSES[theme]);
    this.engine?.refreshTheme();
  }

  private changeTypography(change: () => void): void {
    change();
    this.saveSettings();
    this.engine?.setTypography(this.typography());
  }

  private appearanceRows(): PanelRow[] {
    const reader = this.getSettings().reader;
    const rows: PanelRow[] = [
      {
        kind: "choice",
        label: "Theme",
        options: READING_THEMES.map((theme) => ({ value: theme, label: THEME_LABELS[theme], cls: `ereader-swatch is-${theme}` })),
        value: reader.readingTheme,
        onChange: (value) => {
          reader.readingTheme = value as ReadingTheme;
          this.saveSettings();
          this.applyTheme();
        },
      },
    ];
    const engine = this.engine;
    if (engine) {
      const scale = engine.scale();
      rows.push({
        kind: "stepper",
        label: this.format === "epub" ? "Text size" : "Zoom",
        valueLabel: `${Math.round(scale * 100)}%`,
        canDecrease: scale > MIN_SCALE,
        canIncrease: scale < MAX_SCALE,
        onStep: (direction) => this.zoom(direction),
      });
    }
    const options = this.displayOptions();
    rows.push(...optionRows(options.filter((option) => option.section !== "appearance")));
    if (this.format === "epub") {
      rows.push(
        {
          kind: "choice",
          label: "Font",
          options: BOOK_FONTS.map((font) => ({ value: font, label: FONT_LABELS[font], cls: `ereader-font is-${font}` })),
          value: reader.epubFont,
          onChange: (value) => this.changeTypography(() => (reader.epubFont = value as Typography["font"])),
        },
        {
          kind: "choice",
          label: "Line spacing",
          options: LINE_SPACINGS.map((spacing) => ({ value: spacing, label: LINE_SPACING_LABELS[spacing] })),
          value: reader.epubLineSpacing,
          onChange: (value) => this.changeTypography(() => (reader.epubLineSpacing = value as Typography["lineSpacing"])),
        },
        {
          kind: "choice",
          label: "Margins",
          options: MARGINS.map((margins) => ({ value: margins, label: MARGIN_LABELS[margins] })),
          value: reader.epubMargins,
          onChange: (value) => this.changeTypography(() => (reader.epubMargins = value as Typography["margins"])),
        },
        {
          kind: "toggle",
          label: "Justify text",
          value: reader.epubJustify,
          onChange: (value) => this.changeTypography(() => (reader.epubJustify = value)),
        },
        {
          kind: "toggle",
          label: "Hyphenate",
          value: reader.epubHyphenate,
          onChange: (value) => this.changeTypography(() => (reader.epubHyphenate = value)),
        },
      );
    }
    rows.push(...optionRows(options.filter((option) => option.section === "appearance")));
    return rows;
  }

  // -------------------------------------------------------------- footer

  private buildFooter(root: HTMLElement): NonNullable<ReaderView["footer"]> {
    const el = root.createDiv({ cls: "ereader-footer" });
    // How far through the book, with a tick where each chapter starts.
    const trackEl = el.createDiv({ cls: "ereader-footer__track", attr: { "aria-hidden": "true" } });
    const barEl = trackEl.createDiv({ cls: "ereader-footer__bar" });
    const ticksEl = trackEl.createDiv({ cls: "ereader-footer__ticks" });
    const chapterEl = el.createSpan({ cls: "ereader-footer__chapter" });
    const rightEl = el.createDiv({ cls: "ereader-footer__right" });
    const chapterLeftEl = rightEl.createSpan({ cls: "ereader-footer__chapter-left" });
    const bookEl = rightEl.createSpan({ cls: "ereader-footer__book" });
    // A tap switches the time left between the chapter and the whole book.
    el.addEventListener("click", () => {
      const reader = this.getSettings().reader;
      reader.footerTime = reader.footerTime === "chapter" ? "book" : "chapter";
      this.saveSettings();
      this.updateFooter();
    });
    el.hide();
    return { el, chapterEl, chapterLeftEl, bookEl, barEl, ticksEl, ticksFor: null };
  }

  /**
   * The line under the page: the chapter, the time left in it, and how far
   * through the book. Time is units left × the pace learned from the
   * reader's own page turns (reading-time.ts).
   */
  private updateFooter(): void {
    const footer = this.footer;
    if (!footer) return;
    const engine = this.engine;
    const pages = engine?.pageState() ?? null;
    if (!engine || !this.getSettings().reader.showFooter) {
      footer.el.hide();
      return;
    }
    if (!pages) {
      this.showFooterPlaceholder();
      return;
    }
    footer.el.show();
    const pace = this.pace();
    const starts = this.chapterStartsFor(engine, pages.total);
    const chapter = chapterAt(starts, pages.current, pages.total);
    const bookLeft = formatDuration(unitsLeft(pages.current, pages.total + 1) * pace);
    const progress = engine.progress();
    const percent = progressLabel(pages, progress);
    footer.chapterEl.setText(chapter?.label ?? "");
    footer.bookEl.setText(percent);
    footer.barEl.setCssStyles({ width: `${Math.min(100, Math.max(0, progress))}%` });
    if (footer.ticksFor !== starts) {
      footer.ticksFor = starts;
      footer.ticksEl.empty();
      for (const at of chapterTicks(starts, pages.total)) {
        footer.ticksEl.createDiv({ cls: "ereader-footer__tick" }).setCssStyles({ left: `${at * 100}%` });
      }
    }
    const switchHint = "Tap to switch between the chapter and the book";
    if (chapter && this.getSettings().reader.footerTime === "chapter") {
      const fraction = chapterFraction(chapter, pages.current);
      footer.chapterLeftEl.setText(`${formatDuration(unitsLeft(pages.current, chapter.end) * pace)} left in chapter`);
      setTooltip(footer.el, `${Math.round(fraction * 100)}% through this chapter · about ${bookLeft} left in the book. ${switchHint}`, { placement: "top" });
    } else {
      footer.chapterLeftEl.setText(`${bookLeft} left in book`);
      setTooltip(footer.el, chapter ? `${percent} through the book. ${switchHint}` : `${percent} through the book`, { placement: "top" });
    }
  }

  /**
   * The footer before there is anything to put in it: while the book opens,
   * and while an EPUB's pages are counted in the background. Showing it at
   * once also means its height is known before the page is laid out.
   */
  private showFooterPlaceholder(): void {
    const footer = this.footer;
    if (!footer || !this.getSettings().reader.showFooter) return;
    footer.el.show();
    footer.chapterEl.setText("");
    footer.chapterLeftEl.setText("Calculating time left…");
    footer.bookEl.setText("");
    footer.barEl.setCssStyles({ width: "0" });
    footer.ticksEl.empty();
    footer.ticksFor = null;
    setTooltip(footer.el, "Counting the pages in this book", { placement: "top" });
  }

  /** The contents placed on the page/location scale; empty until the contents are read. */
  private chapterStartsFor(engine: ReaderEngine, total: number): ChapterStart[] {
    if (this.chapterStarts?.total === total) return this.chapterStarts.starts;
    if (!this.cachedOutline) return [];
    const starts = rowsFromOutline(this.cachedOutline).map((row) => ({
      label: row.label,
      unit: row.target.kind === "book" ? engine.pageNumberFor(row.target.locator) : null,
      depth: row.depth,
    }));
    this.chapterStarts = { total, starts };
    return starts;
  }

  private pace(): number {
    const reader = this.getSettings().reader;
    return this.format === "pdf" ? reader.pacePdfMs : reader.paceEpubMs;
  }

  /** Learns the reader's pace from each step forward; a jump resets the anchor instead. */
  private trackPace(): void {
    const unit = this.engine?.pageState()?.current;
    if (unit === undefined) return;
    const anchor = this.paceAnchor;
    if (anchor?.unit === unit) return;
    const now = Date.now();
    this.paceAnchor = { unit, at: now };
    if (!anchor) return;
    const next = nextPace(this.pace(), anchor.unit, unit, now - anchor.at);
    if (next === null) return;
    const reader = this.getSettings().reader;
    if (this.format === "pdf") reader.pacePdfMs = next;
    else reader.paceEpubMs = next;
    this.savePace();
  }

  // ---------------------------------------------------------------- back

  /**
   * Remembers where the reader is before a jump — a contents entry, a typed
   * page, a link, a search result — so the place can be offered back. A jump
   * made while "Back" is already showing keeps the first place: that is the
   * one the reader was reading at.
   */
  private recordJump(): void {
    this.paceAnchor = null;
    if (this.chip?.kind === "back") return;
    const from = this.engine?.currentLocator();
    if (from) this.pendingBack = { target: from, at: Date.now() };
  }

  /** Shows "Back" once a jump has landed somewhere else; a jump to the same page offers nothing. */
  private settleBack(): void {
    const pending = this.pendingBack;
    const engine = this.engine;
    const chip = this.chip;
    if (chip?.kind === "back" && engine) {
      const here = engine.pageState()?.current;
      if (here !== undefined && engine.pageNumberFor(chip.target) === here) this.closeChip();
    }
    if (!pending || !engine) return;
    // A link that went nowhere leaves its record behind; it must not turn the
    // next ordinary page turn into a "Back".
    if (Date.now() - pending.at > 3000) {
      this.pendingBack = null;
      return;
    }
    const here = engine.pageState()?.current;
    const there = engine.pageNumberFor(pending.target);
    if (here === undefined || there === null || here === there) return;
    this.pendingBack = null;
    this.showBackChip(pending.target);
  }

  private showBackChip(target: Locator): void {
    if (this.chip?.kind === "back") return;
    this.showChip("back", target, "undo-2", this.backLabel(target));
  }

  /** Puts a place to go in the chip slot, replacing whatever was there. */
  private showChip(kind: "resume" | "back", target: Locator, icon: string, label: string): void {
    const root = this.contentRoot;
    if (!root) return;
    this.closeChip();
    this.measureChrome();
    const chip = root.createDiv({ cls: "ereader-chip" });
    const go = chip.createEl("button", { cls: "ereader-chip__go" });
    setIcon(go.createSpan({ cls: "ereader-chip__icon" }), icon);
    go.createSpan({ cls: "ereader-chip__label", text: label });
    go.addEventListener("click", () => {
      this.closeChip();
      // Taking the resume offer is a jump like any other, with a way back.
      void this.goToLocator(target, kind === "resume");
    });
    const dismiss = chip.createEl("button", { cls: "clickable-icon ereader-chip__dismiss", attr: { "aria-label": "Dismiss" } });
    setIcon(dismiss, "x");
    dismiss.addEventListener("click", () => this.closeChip());
    this.chip = { el: chip, kind, target };
  }

  private backLabel(target: Locator): string {
    if (target.kind === "pdf") return `Back to page ${target.page}`;
    const title = this.chapterTitleAt(target);
    return title ? `Back to ${title}` : "Back";
  }

  private closeChip(): void {
    this.chip?.el.remove();
    this.chip = null;
  }

  /**
   * Publishes the toolbar's and footer's heights for the panels and the back
   * chip to sit clear of. Both depend on the theme, on whether the toolbar's
   * buttons wrap, and on whether either is showing at all.
   */
  private measureChrome(): void {
    const root = this.contentRoot;
    if (!root) return;
    const toolbar = root.querySelector<HTMLElement>(".ereader-toolbar");
    const toolbarHeight = toolbar?.offsetHeight ?? 0;
    const footerHeight = this.footer?.el.offsetHeight ?? 0;
    const inset = this.bottomInset(root);
    // On a phone the footer sits under the toolbar (styles.css), leaving the
    // bottom of the screen to the book and to Obsidian's floating bar.
    const footerOnTop = Platform.isPhone;
    root.setCssProps({
      "--ereader-toolbar-h": `${toolbarHeight}px`,
      "--ereader-bottom-inset": `${inset}px`,
      "--ereader-top-h": `${toolbarHeight + (footerOnTop ? footerHeight : 0)}px`,
      // Everything that keeps clear of the footer keeps clear of what is under it too.
      "--ereader-bottom-h": `${footerOnTop ? 0 : footerHeight + inset}px`,
    });
  }

  /**
   * How much of the bottom of the reader Obsidian's phone navigation bar
   * covers. The bar floats over the bottom of the pane rather than sitting
   * below it, so the footer is lifted clear of it. Measured even while the
   * bar is faded out over an EPUB, so the page underneath never moves.
   */
  private bottomInset(root: HTMLElement): number {
    if (!Platform.isMobile) return 0;
    const navbar = root.doc.querySelector<HTMLElement>(".mobile-navbar");
    if (!navbar) return 0;
    const bar = navbar.getBoundingClientRect();
    const pane = root.getBoundingClientRect();
    if (bar.height <= 0 || bar.top >= pane.bottom || bar.bottom <= pane.top) return 0;
    return Math.max(0, Math.round(pane.bottom - bar.top));
  }

  /** Everything that belongs to one open book, cleared when it closes or another opens. */
  private resetBookChrome(): void {
    this.search?.reset();
    this.searchMark = null;
    this.appearance?.hide();
    this.chapterStarts = null;
    this.paceAnchor = null;
    this.pendingBack = null;
    this.closeChip();
    this.footer?.el.hide();
    this.savePace.run();
  }

  // ---------------------------------------------------------- immersive

  /**
   * Hides the toolbar and footer to give the page the whole pane, or brings
   * them back. Not remembered: a book always opens with its controls showing.
   */
  toggleChrome(): void {
    const root = this.contentRoot;
    if (!root) return;
    this.setChromeHidden(!root.hasClass("is-immersive"));
  }

  private setChromeHidden(hidden: boolean): void {
    const root = this.contentRoot;
    if (!root || root.hasClass("is-immersive") === hidden) return;
    // Bars hidden under an open panel would leave it floating over nothing.
    if (hidden && (this.search?.isOpen() || this.appearance?.isOpen())) return;
    root.toggleClass("is-immersive", hidden);
    this.syncAppChrome();
  }

  /**
   * On a phone, Obsidian's own bar along the bottom (search, new note, tabs,
   * menu) goes and comes back with the reader's bars, while this reader is
   * the pane in front. It belongs to the whole app, so it is only ever
   * hidden through a class on the body, and that class is dropped the
   * moment another pane takes over or the reader closes.
   */
  private syncAppChrome(): void {
    const body = this.containerEl.doc.body;
    const hide =
      Platform.isMobile &&
      this.engine !== null &&
      this.contentRoot?.hasClass("is-immersive") === true &&
      this.app.workspace.getActiveViewOfType(ReaderView) === this;
    body.toggleClass("ereader-immersive-epub", hide && this.format === "epub");
    body.toggleClass("ereader-immersive-pdf", hide && this.format === "pdf");
  }

  /**
   * Keeps the heights the page and the panels keep clear of up to date. The
   * bars float over the page (see styles.css), so their size changing — the
   * toolbar showing, the footer turned on, a narrow pane wrapping them — is
   * the one thing that moves the page.
   */
  private watchChrome(root: HTMLElement): void {
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => this.measureChrome());
      const toolbarEl = root.querySelector<HTMLElement>(".ereader-toolbar");
      if (toolbarEl) observer.observe(toolbarEl);
      if (this.footer) observer.observe(this.footer.el);
      // The pane itself and Obsidian's phone bar, for the footer's lift.
      observer.observe(root);
      const navbar = root.doc.querySelector<HTMLElement>(".mobile-navbar");
      if (navbar) observer.observe(navbar);
      this.register(() => observer.disconnect());
    }
    if (Platform.isMobile) return;
    // A desktop's bars can hide themselves once the pointer is still, and
    // come back when it moves, or reaches the top of the pane.
    this.registerDomEvent(root, "mousemove", () => this.noteActivity());
    const reveal = root.createDiv({ cls: "ereader-reader__reveal" });
    this.registerDomEvent(reveal, "mouseenter", () => this.noteActivity());
  }

  /** The pointer moved: show the bars, and on a desktop with auto-hide on, start the countdown to hiding them. */
  private noteActivity(): void {
    if (Platform.isMobile || !this.getSettings().reader.autoHideChrome) return;
    this.setChromeHidden(false);
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      const root = this.contentRoot;
      if (!root || !this.engine || !this.getSettings().reader.autoHideChrome) return;
      // Not while the pointer rests on a bar, or something in one has focus.
      const bars = [root.querySelector(".ereader-toolbar"), this.footer?.el];
      if (bars.some((el) => el?.matches(":hover") || el?.contains(root.doc.activeElement))) {
        this.noteActivity();
        return;
      }
      this.setChromeHidden(true);
    }, CHROME_IDLE_MS);
  }

  /**
   * On a touchscreen, scrolling down into the book hides the bars and
   * scrolling back up shows them. Only the page's own scroller counts, not a
   * panel's list.
   */
  private followScroll(target: EventTarget | null): void {
    if (!Platform.isMobile || !(target instanceof HTMLElement) || !this.engine) return;
    if (!target.closest(".ereader-reader__viewport")) return;
    if (target !== this.scrollChromeEl) {
      this.scrollChromeEl = target;
      this.scrollChrome.reset();
    }
    const action = this.scrollChrome.update(target.scrollTop, target.clientHeight);
    if (action) this.setChromeHidden(action === "hide");
  }

  /**
   * On a touchscreen, a tap in the middle of the page shows or hides the
   * toolbar, the way dedicated reading apps do. The edges are left alone —
   * a paginated book turns its pages there — and so is any tap that is
   * really the reader putting a selection down.
   */
  private toggleChromeFromTap(position: { x: number; y: number }): void {
    if (!Platform.isMobile || !this.contentRoot) return;
    if (this.popup?.isPressed() || Date.now() - this.selectionSeenAt < SELECTION_DISMISS_MS) return;
    const rect = this.contentRoot.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = (position.x - rect.left) / rect.width;
    const edge = (1 - CHROME_TAP_ZONE) / 2;
    if (fraction < edge || fraction > 1 - edge) return;
    this.toggleChrome();
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
    const hit = this.engine?.highlightAt(position) ?? null;
    if (hit !== null) {
      const entry = this.entries.find((candidate) => candidate.id === hit);
      if (entry) return entry;
    }
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

  /**
   * A tap that lands on a painted highlight opens that highlight's own
   * actions. This is the touch route to them — a long press cannot be, since
   * iOS stopped firing `contextmenu` on one in iOS 13 — and it matches what
   * foliate-js and epub.js both do, which is to treat a click on an
   * annotation as selecting it.
   *
   * A tap that lands on nothing is ordinary reading and is ignored, and a
   * tap that ends a text selection is the reader finishing a drag, not
   * asking about whatever sits under the release.
   */
  private showEntryMenuAt(position: { x: number; y: number }): void {
    // A tap inside an EPUB never reaches the host document, where the
    // settings panel listens for presses outside it, so it is closed here.
    if (this.appearance?.isOpen()) {
      this.appearance.hide();
      return;
    }
    if (this.engine?.getSelection()) return;
    const entry = this.entryAt(position);
    const note = this.bookNote();
    if (!entry || !note) {
      if (!entry) this.toggleChromeFromTap(position);
      return;
    }
    const menu = new Menu();
    this.addEntryItems(menu, note, entry, this.getSettings().annotationTypes);
    menu.showAtPosition(position);
  }

  /**
   * Returns whether the press was taken. On a touchscreen it is taken ONLY
   * over an existing highlight: a long press there is unambiguously about
   * that highlight, whereas anywhere else it is the reader starting a
   * selection, and claiming it would destroy the selection being made. On a
   * pointer device a right-click is never a selection gesture, so the menu
   * always opens.
   */
  private showAnnotationMenu(position: { x: number; y: number }): boolean {
    // The menu offers everything the popup does; showing both stacks two
    // answers to one question.
    this.closePopup(false);
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
      return true;
    }
    if (Platform.isMobile) return false;

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
    return true;
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
      addCopyItems(menu, this.app, note, entry, this.getSettings().highlights);
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
      await setEntryType(this.app, note, entry.id, type, this.getSettings());
    } catch (error) {
      console.error("[e-reader] failed to change an entry's type", error);
      new Notice("E-Reader: could not change that highlight — see the console.");
    }
  }

  private async deleteEntry(note: TFile, entry: Entry): Promise<void> {
    try {
      await removeEntry(this.app, note, entry.id, this.getSettings());
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
    // Saving a highlight with painting switched off looks exactly like it
    // failing: the entry lands in the note and nothing appears on the page.
    if (type !== BOOKMARK_TYPE && !this.getSettings().reader.showHighlights) {
      new Notice("E-Reader: highlight saved. Turn on “Show saved highlights” in reading settings (Aa) to see it in the book.");
    }
    try {
      const page = hint ? (this.engine?.pageNumberFor(hint) ?? undefined) : undefined;
      const section = hint ? await this.sectionTitle(hint) : undefined;
      await addEntry(
        this.app,
        note,
        {
          type,
          exact: selection?.exact ?? "",
          prefix: selection?.prefix ?? "",
          suffix: selection?.suffix ?? "",
          ...(hint === undefined ? {} : { hint }),
          ...(page === undefined ? {} : { page }),
          ...(section === undefined ? {} : { section }),
        },
        this.getSettings(),
      );
    } catch (error) {
      console.error("[e-reader] failed to write an entry", error);
      new Notice("E-Reader: could not save that highlight — see the console.");
    }
  }

  /** The table-of-contents entry `locator` falls under, recorded with each highlight. */
  private async sectionTitle(locator: Locator): Promise<string | undefined> {
    const rows = rowsFromOutline(await this.outline());
    const row = rows[activeRowIndex(rows, locator)];
    return row?.label.trim() || undefined;
  }

  private readStoredLocator(bookNote: TFile, property: string): Locator | null {
    const cache = this.app.metadataCache.getFileCache(bookNote);
    const raw = cache?.frontmatter?.[property];
    return typeof raw === "string" ? parseLocator(raw) : null;
  }

  /**
   * Offers a single-step jump to the furthest-read position (FR-015b). The
   * reader stays where it was restored unless they accept; dismissing the
   * offer, or reading on past that point, writes nothing.
   */
  private offerJump(target: Locator): void {
    if (!this.engine) return;
    const title = target.kind === "pdf" ? null : this.chapterTitleAt(target);
    const label =
      target.kind === "pdf" ? `Jump to page ${target.page}, the furthest you read` : title ? `Jump to ${title}, the furthest you read` : "Jump to the furthest you read";
    this.showChip("resume", target, "fast-forward", label);
  }

  /** Reading on to the offered place makes the offer moot. */
  private dropJumpOfferIfReached(): void {
    const offer = this.chip;
    const current = this.engine?.currentLocator();
    if (offer?.kind !== "resume" || !current) return;
    const order = compareLocators(current, offer.target);
    if (order !== null && order >= 0) this.closeChip();
  }

  private currentPosition(): ReadingPosition | null {
    if (!this.engine) return null;
    const locator = this.engine.currentLocator();
    if (!locator) return null;
    return { progress: clampProgress(this.engine.progress()), locator: serializeLocator(locator) };
  }

  /**
   * Writes progress, position and furthest position to the book note's
   * frontmatter, under the reader's CONFIGURED names (FR-006) — these were
   * hardcoded, so renaming one in settings left the reader writing one key
   * while the library read another, and progress silently stopped updating.
   * Only those three keys are touched (FileManager.processFrontMatter mutates the parsed
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
        frontmatter[properties.furthestRead] = furthestOf(
          [frontmatter[properties.furthestRead], frontmatter[properties.lastRead]],
          current.locator,
        );
        frontmatter[properties.lastRead] = current.locator;
      });
    } catch (error) {
      console.error("[e-reader] failed to write reading position", error);
    }
  }
}
