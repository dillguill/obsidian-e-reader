// The `library` Bases view. Renders from `this.data.groupedData` so
// whatever groupBy/sort/filter the user configured in Bases is honoured —
// this class never filters, sorts, searches, or groups on its own. Opening a
// book just points a leaf at the reader view (src/reader/reader-view.ts) with
// the book note's path. The only write is the card menu's "Mark as finished"
// or "Mark as unread", which the reader asks for by name.

import type { BasesEntry, BasesPropertyId, QueryController, TFile } from "obsidian";
import { BasesView, Component, Menu, setIcon } from "obsidian";
import type { ImportResult, ImportSource } from "../import/importer";
import { IMPORTABLE_EXTENSIONS } from "../import/importer";
import type { Settings } from "../settings/settings-model";
import { READER_VIEW_TYPE, type ReaderViewState } from "../reader/reader-view";
import { type CardState, renderCard } from "./card";
import { resolveBookAttachment } from "../core/attachment";
import { type OpenBookModifiers, decideOpenTarget } from "./open-book";
import { type LibraryViewConfig, readLibraryViewConfig } from "./view-config";

export const LIBRARY_VIEW_TYPE = "library";

/**
 * Cards rendered per frame. A large library rendered in one go froze the
 * pane until every card was built; in batches, the first screenful appears
 * at once and the rest follows while the reader is already looking.
 */
const CARDS_PER_FRAME = 48;
/** How long a finger rests on a card before its menu opens. iOS never fires `contextmenu`. */
const LONG_PRESS_MS = 500;
/** How far a finger may drift during that press before it counts as a scroll. */
const LONG_PRESS_SLOP_PX = 10;

export class LibraryView extends BasesView {
  type = LIBRARY_VIEW_TYPE;

  private readonly containerEl: HTMLElement;
  private rootEl: HTMLElement;
  /** Child component scoping one render pass's DOM event registrations, torn down and replaced on the next render. */
  private renderScope: Component | null = null;
  /** The pending batch of the current render, cancelled when a new render starts. */
  private pendingFrame: number | null = null;

  constructor(
    controller: QueryController,
    containerEl: HTMLElement,
    private readonly getSettings: () => Settings,
    private readonly importBook: (source: ImportSource) => Promise<ImportResult | null>,
    private readonly attachFile: (note: TFile) => Promise<boolean>,
  ) {
    super(controller);
    this.containerEl = containerEl;
    this.rootEl = containerEl.createDiv({ cls: "ereader-library" });
    this.watchDrops();
  }

  /** EPUBs and PDFs dropped onto the library from outside the vault are imported. */
  private watchDrops(): void {
    const carriesFiles = (evt: DragEvent): boolean => evt.dataTransfer?.types.includes("Files") ?? false;
    // dragenter/dragleave fire for every child crossed, so the highlight
    // counts them rather than toggling.
    let depth = 0;
    this.registerDomEvent(this.containerEl, "dragenter", (evt: DragEvent) => {
      if (!carriesFiles(evt)) return;
      depth++;
      this.rootEl.addClass("is-drop-target");
    });
    this.registerDomEvent(this.containerEl, "dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.rootEl.removeClass("is-drop-target");
    });
    this.registerDomEvent(this.containerEl, "dragover", (evt: DragEvent) => {
      if (!carriesFiles(evt)) return;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "copy";
    });
    this.registerDomEvent(this.containerEl, "drop", (evt: DragEvent) => {
      depth = 0;
      this.rootEl.removeClass("is-drop-target");
      const files = Array.from(evt.dataTransfer?.files ?? []).filter((file) =>
        IMPORTABLE_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? ""),
      );
      if (files.length === 0) return;
      evt.preventDefault();
      evt.stopPropagation();
      void (async () => {
        for (const file of files) await this.importBook({ kind: "external", name: file.name, data: await file.arrayBuffer() });
      })();
    });
  }

  onDataUpdated(): void {
    try {
      this.render();
    } catch (error) {
      console.error("[e-reader] library view render failed", error);
      this.cancelPending();
      this.rootEl.empty();
      this.renderMessage("alert-triangle", "The library could not be shown.", String(error));
    }
  }

  override onunload(): void {
    this.cancelPending();
  }

  private cancelPending(): void {
    if (this.pendingFrame !== null) window.cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = null;
  }

  private renderMessage(icon: string, title: string, detail: string): void {
    const el = this.rootEl.createDiv({ cls: "ereader-library__message" });
    setIcon(el.createDiv({ cls: "ereader-library__message-icon" }), icon);
    el.createDiv({ cls: "ereader-library__message-title", text: title });
    el.createDiv({ cls: "ereader-library__message-detail", text: detail });
  }

  private render(): void {
    if (this.renderScope) {
      this.removeChild(this.renderScope);
    }
    const scope = this.addChild(new Component());
    this.renderScope = scope;

    this.rootEl.empty();
    const libConfig = readLibraryViewConfig(this.config, this.getSettings().properties);
    // Obsidian's own Cards view sizes items from JS; ours needs a width in CSS.
    // `cardSize` is the same config key the built-in view reads.
    this.rootEl.setCssProps({
      "--ereader-card-w": `${libConfig.cardSize}px`,
      "--ereader-ar": `${libConfig.imageAspectRatio}`,
    });

    const groups = this.data.groupedData ?? [];
    const total = groups.reduce((n, g) => n + g.entries.length, 0);
    // Fall back to the ungrouped set if grouping yields nothing.
    const effective = total > 0 ? groups : [{ hasKey: () => false, key: undefined, entries: this.data.data ?? [] }];

    if (effective.every((group) => group.entries.length === 0)) {
      const { marker, markerValue, attachments } = this.getSettings().properties;
      this.renderMessage(
        "library",
        "No books here yet",
        `Drop an EPUB or PDF here to import it. A book is a note with "${marker}: ${markerValue}" and its file ` +
          `linked in "${attachments}"; if you have some, check this view's filters.`,
      );
      return;
    }

    // Every group's heading and grid is laid out up front so the page has its
    // shape; the cards then fill in a batch at a time.
    const queue: { gridEl: HTMLElement; entry: BasesEntry }[] = [];
    for (const group of effective) {
      if (group.hasKey()) {
        this.rootEl.createDiv({ cls: "ereader-library__heading", text: group.key?.toString() ?? "" });
      }
      const gridEl = this.rootEl.createDiv({ cls: "ereader-library__group" });
      gridEl.setCssStyles({
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${libConfig.cardSize}px, 1fr))`,
        gap: "16px",
        marginBottom: "24px",
      });
      for (const entry of group.entries) queue.push({ gridEl, entry });
    }

    this.cancelPending();
    let next = 0;
    const renderBatch = (): void => {
      this.pendingFrame = null;
      const end = Math.min(queue.length, next + CARDS_PER_FRAME);
      for (; next < end; next++) {
        const item = queue[next];
        if (item) this.renderEntry(scope, item.gridEl, item.entry, libConfig);
      }
      if (next < queue.length) this.pendingFrame = window.requestAnimationFrame(renderBatch);
    };
    renderBatch();
  }

  private renderEntry(
    scope: Component,
    gridEl: HTMLElement,
    entry: BasesEntry,
    libConfig: LibraryViewConfig,
  ): void {
    const card = renderCard(this.app, entry, this.config, libConfig, this.cardState(entry.file));
    gridEl.appendChild(card);

    // A long press opens the menu on a touchscreen. The click that follows
    // the finger lifting must not then open the book as well.
    let pressTimer: number | null = null;
    let pressFrom: { x: number; y: number } | null = null;
    let menuOpened = false;
    const cancelPress = (): void => {
      if (pressTimer !== null) window.clearTimeout(pressTimer);
      pressTimer = null;
    };
    scope.register(cancelPress);
    scope.registerDomEvent(card, "touchstart", (evt: TouchEvent) => {
      cancelPress();
      menuOpened = false;
      const touch = evt.touches[0];
      if (evt.touches.length !== 1 || !touch) return;
      pressFrom = { x: touch.clientX, y: touch.clientY };
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        menuOpened = true;
        this.cardMenu(entry, libConfig.progressProperty).showAtPosition({ x: pressFrom?.x ?? 0, y: pressFrom?.y ?? 0 });
      }, LONG_PRESS_MS);
    }, { passive: true });
    scope.registerDomEvent(card, "touchmove", (evt: TouchEvent) => {
      const touch = evt.touches[0];
      if (!touch || !pressFrom) return;
      if (Math.hypot(touch.clientX - pressFrom.x, touch.clientY - pressFrom.y) > LONG_PRESS_SLOP_PX) cancelPress();
    }, { passive: true });
    scope.registerDomEvent(card, "touchend", cancelPress);
    scope.registerDomEvent(card, "touchcancel", cancelPress);

    scope.registerDomEvent(card, "click", (evt: MouseEvent) => {
      if (menuOpened) {
        menuOpened = false;
        evt.preventDefault();
        return;
      }
      this.openBook(entry, { ctrlKey: evt.ctrlKey, metaKey: evt.metaKey, altKey: evt.altKey, button: evt.button });
    });
    scope.registerDomEvent(card, "keydown", (evt: KeyboardEvent) => {
      if (evt.key !== "Enter" && evt.key !== " ") return;
      evt.preventDefault();
      this.openBook(entry, { ctrlKey: evt.ctrlKey, metaKey: evt.metaKey, altKey: evt.altKey });
    });
    scope.registerDomEvent(card, "contextmenu", (evt: MouseEvent) => {
      evt.preventDefault();
      // Android fires this on a long press too; the timer's menu is enough.
      if (menuOpened) return;
      cancelPress();
      this.cardMenu(entry, libConfig.progressProperty).showAtMouseEvent(evt);
    });
  }

  private cardState(note: TFile): CardState {
    const { attachments, readLater } = this.getSettings().properties;
    const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter;
    return {
      hasFile: resolveBookAttachment(this.app, note, attachments) !== null,
      readLater: frontmatter?.[readLater] === true,
    };
  }

  private cardMenu(entry: BasesEntry, progressProperty: BasesPropertyId | null): Menu {
    const menu = new Menu();
    const state = this.cardState(entry.file);
    if (!state.hasFile) {
      menu.addItem((item) =>
        item
          .setTitle("Add file…")
          .setIcon("file-up")
          .onClick(() => void this.attachFile(entry.file)),
      );
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item
        .setTitle("Open")
        .setIcon("book-open")
        .onClick(() => this.openBook(entry, { ctrlKey: false, metaKey: false, altKey: false })),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open in new tab")
        .setIcon("file-plus")
        .onClick(() => this.openBook(entry, { ctrlKey: true, metaKey: false, altKey: false })),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open note")
        .setIcon("file-text")
        .onClick(() => void this.app.workspace.getLeaf(false).openFile(entry.file)),
    );

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(state.readLater ? "Remove from read later" : "Read later")
        .setIcon(state.readLater ? "bookmark-minus" : "bookmark-plus")
        .onClick(() => void this.setReadLater(entry.file, !state.readLater)),
    );

    // Only a property on the note itself can be written; a formula or a file
    // property bound in the `.base` is read-only.
    const name = progressProperty?.startsWith("note.") ? progressProperty.slice("note.".length) : null;
    if (name !== null) {
      menu.addItem((item) =>
        item
          .setTitle("Mark as finished")
          .setIcon("check")
          .onClick(() => void this.writeProgress(entry, name, 100)),
      );
      menu.addItem((item) =>
        item
          .setTitle("Mark as unread")
          .setIcon("rotate-ccw")
          .onClick(() => void this.writeProgress(entry, name, null)),
      );
    }
    return menu;
  }

  /** Marks a book to read later, or with `false` removes the property rather than leaving it unticked. */
  private async setReadLater(note: TFile, on: boolean): Promise<void> {
    const { readLater } = this.getSettings().properties;
    await this.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
      if (on) frontmatter[readLater] = true;
      else delete frontmatter[readLater];
    });
  }

  /**
   * Sets the book's progress, or with `null` removes it, which is what marks
   * a book unread. Unread also clears the last-read and furthest-read
   * positions: it is the explicit reset that lets furthest-read move back
   * (FR-015a), so the book next opens at its start with no jump offered.
   */
  private async writeProgress(entry: BasesEntry, name: string, value: number | null): Promise<void> {
    const { lastRead, furthestRead } = this.getSettings().properties;
    await this.app.fileManager.processFrontMatter(entry.file, (frontmatter: Record<string, unknown>) => {
      if (value === null) {
        delete frontmatter[name];
        delete frontmatter[lastRead];
        delete frontmatter[furthestRead];
      } else {
        frontmatter[name] = value;
      }
    });
  }

  /**
   * Opens the reader for this book note. Attachment resolution (which file
   * under `attachments` is readable) is the reader view's own job now — see
   * src/reader/reader-view.ts and core/attachment.ts, which this used to
   * duplicate as a private `resolveBookFile` method.
   */
  private openBook(entry: BasesEntry, modifiers: OpenBookModifiers): void {
    const target = decideOpenTarget(modifiers);
    const newLeaf = target === "same-tab" ? false : target === "split" ? "split" : true;
    const leaf = this.app.workspace.getLeaf(newLeaf);
    // `file` (not a key of our own) is what makes FileView call loadFile,
    // which is what fires `file-open` and so points Obsidian's native
    // Outline and Properties panes at this book note.
    const state: ReaderViewState = { file: entry.file.path };
    void leaf.setViewState({ type: READER_VIEW_TYPE, state, active: true });
  }
}
