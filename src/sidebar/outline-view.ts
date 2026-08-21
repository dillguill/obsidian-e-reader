// The book outline pane.
//
// Obsidian's own Outline pane cannot serve this: its `getHeadings()` returns
// `metadataCache.getFileCache(file).headings` and nothing else, so for a
// book note it lists the note's markdown headings and never the EPUB or PDF
// table of contents. (The native Properties pane, by contrast, needs nothing
// from us — see reader/reader-view.ts.)
//
// So this pane shows the book file's own contents when it has any, and falls
// back to the note's headings when it does not (FR-025, FR-025a), tracking
// the active file the same way the native panes do.

import type { TFile, WorkspaceLeaf } from "obsidian";
import { Component, ItemView } from "obsidian";
import type { ReaderEvents } from "../core/reader-events";
import type { Locator } from "../core/types";
import { activeReaderFor, revealReader } from "./active-reader";
import { type OutlineRow, activeRowIndex, rowsFromHeadings, rowsFromOutline } from "./outline-model";

export const OUTLINE_VIEW_TYPE = "ereader-outline";

export class OutlineView extends ItemView {
  private file: TFile | null = null;
  private rows: OutlineRow[] = [];
  private rowEls: HTMLElement[] = [];
  private activeIndex = -1;
  private renderScope: Component | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly events: ReaderEvents,
  ) {
    super(leaf);
    this.icon = "list";
    this.navigation = false;
  }

  override getViewType(): string {
    return OUTLINE_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Book outline";
  }

  override async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.file = file;
        void this.render();
      }),
    );
    // A book's contents only become knowable once its reader has loaded it,
    // so re-render when a reader reports in for the file we are showing.
    this.registerEvent(
      this.events.onPosition((filePath, locator) => {
        if (filePath !== this.file?.path) return;
        if (this.rows.length === 0) void this.render();
        else this.highlightCurrent(locator);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file === this.file && this.rows.every((row) => row.target.kind === "note")) void this.render();
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      this.file = this.app.workspace.getActiveFile();
      void this.render();
    });
  }

  private async render(): Promise<void> {
    if (this.renderScope) this.removeChild(this.renderScope);
    const scope = this.addChild(new Component());
    this.renderScope = scope;

    const container = this.contentEl;
    container.empty();
    container.addClass("ereader-outline");
    this.rows = [];
    this.rowEls = [];
    this.activeIndex = -1;

    const file = this.file;
    if (!file) {
      container.createDiv({ cls: "pane-empty", text: "Open a book to see its contents." });
      return;
    }

    const reader = activeReaderFor(this.app, file);
    const bookRows = reader ? rowsFromOutline(await reader.outline()) : [];
    if (this.file !== file) return; // the active file changed while we read

    const rows = bookRows.length > 0 ? bookRows : this.noteRows(file);
    this.rows = rows;

    if (rows.length === 0) {
      const message = reader
        ? "This book has no table of contents, and the note has no headings."
        : "Open the book to see its contents.";
      container.createDiv({ cls: "pane-empty", text: message });
      return;
    }

    const listEl = container.createDiv({ cls: "ereader-outline__list" });
    rows.forEach((row, index) => {
      const rowEl = listEl.createDiv({ cls: "ereader-outline__row", text: row.label });
      rowEl.setCssProps({ "--ereader-outline-depth": String(row.depth) });
      rowEl.setAttribute("role", "button");
      rowEl.tabIndex = 0;
      this.rowEls.push(rowEl);
      scope.registerDomEvent(rowEl, "click", () => void this.openRow(file, row));
      scope.registerDomEvent(rowEl, "keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void this.openRow(file, row);
      });
    });

    this.highlightCurrent(reader?.currentLocator() ?? null);
  }

  /** The book note's own headings, read from the metadata cache. */
  private noteRows(file: TFile): OutlineRow[] {
    const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
    return rowsFromHeadings(
      headings.map((heading) => ({ heading: heading.heading, level: heading.level, line: heading.position.start.line })),
    );
  }

  private highlightCurrent(locator: Locator | null): void {
    const next = activeRowIndex(this.rows, locator);
    if (next === this.activeIndex) return;
    this.rowEls[this.activeIndex]?.removeClass("is-active");
    this.activeIndex = next;
    this.rowEls[next]?.addClass("is-active");
  }

  private async openRow(file: TFile, row: OutlineRow): Promise<void> {
    if (row.target.kind === "note") {
      await this.app.workspace.openLinkText(file.path, file.path, false, {
        eState: { line: row.target.line },
      });
      return;
    }
    const reader = activeReaderFor(this.app, file);
    if (!reader) return;
    revealReader(this.app, reader);
    await reader.goToLocator(row.target.locator);
  }
}
