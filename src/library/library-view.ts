// The `library` Bases view. Renders from `this.data.groupedData` so
// whatever groupBy/sort/filter the user configured in Bases is honoured —
// this class never filters, sorts, searches, or groups on its own. Opening a
// book just points a leaf at the reader view (src/reader/reader-view.ts) with
// the book note's path. The only write is the card menu's "Mark as finished"
// or "Mark as unread", which the reader asks for by name.

import type { BasesEntry, BasesPropertyId, QueryController } from "obsidian";
import { BasesView, Component, Menu, setIcon } from "obsidian";
import type { Settings } from "../settings/settings-model";
import { READER_VIEW_TYPE, type ReaderViewState } from "../reader/reader-view";
import { renderCard } from "./card";
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
  ) {
    super(controller);
    this.containerEl = containerEl;
    this.rootEl = containerEl.createDiv({ cls: "ereader-library" });
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
        `A book is a note with "${marker}: ${markerValue}" and its EPUB or PDF linked in "${attachments}". ` +
          "If you have some, check this view's filters.",
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
    const card = renderCard(this.app, entry, this.config, libConfig);
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

  private cardMenu(entry: BasesEntry, progressProperty: BasesPropertyId | null): Menu {
    const menu = new Menu();
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

    // Only a property on the note itself can be written; a formula or a file
    // property bound in the `.base` is read-only.
    const name = progressProperty?.startsWith("note.") ? progressProperty.slice("note.".length) : null;
    if (name !== null) {
      menu.addSeparator();
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

  /** Sets the book's progress, or with `null` removes it, which is what marks a book unread. */
  private async writeProgress(entry: BasesEntry, name: string, value: number | null): Promise<void> {
    await this.app.fileManager.processFrontMatter(entry.file, (frontmatter: Record<string, unknown>) => {
      if (value === null) delete frontmatter[name];
      else frontmatter[name] = value;
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
