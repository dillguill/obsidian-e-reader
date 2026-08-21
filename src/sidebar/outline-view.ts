// The outline pane — one outline for books and for ordinary notes.
//
// Obsidian's own Outline pane cannot serve a book: its `getHeadings()`
// returns `metadataCache.getFileCache(file).headings` and nothing else, so
// for a book note it lists that note's markdown headings and never the EPUB
// or PDF table of contents. (Its Properties pane, by contrast, needs nothing
// from us — see reader/reader-view.ts.) Since a separate pane is unavoidable
// for books, this one also handles plain notes so there is one outline to
// keep open rather than two.
//
// The chrome is Obsidian's, the behaviour is ours. Obsidian's tree widget,
// nav header and infinity-scroll are unexported internals and stay
// off-limits, but their CSS classes are a supported styling surface, and
// they are pure CSS here: `.tree-item-children` indents through
// padding/margin tokens and draws the indentation guide, `.tree-item-self`
// carries hover and active states, `.collapse-icon.is-collapsed` rotates the
// caret. Verified against the app stylesheet — none of it depends on
// JS-computed positions, unlike the virtualized `.bases-cards-*` classes,
// which is why borrowing those produced zero-size cards.
//
// Two things Obsidian does NOT give us and this file must: hiding a
// collapsed subtree (its trees remove those nodes in JS, so there is no
// `.is-collapsed > .tree-item-children` rule to inherit — see styles.css),
// and cursor tracking (`editor-selection-change` is not in the public API,
// so follow-cursor listens to the DOM's own `selectionchange` and reads the
// line through the public Editor).

import type { TFile, WorkspaceLeaf } from "obsidian";
import { Component, ItemView, MarkdownView, SearchComponent, debounce, setIcon, setTooltip } from "obsidian";
import type { ReaderEvents } from "../core/reader-events";
import type { Locator } from "../core/types";
import { activeReaderFor, revealReader } from "./active-reader";
import {
  type OutlineRow,
  activeRowIndex,
  activeRowIndexForLine,
  filterRows,
  rowsFromHeadings,
  rowsFromOutline,
} from "./outline-model";

export const OUTLINE_VIEW_TYPE = "ereader-outline";

const CURSOR_POLL_MS = 100;

interface RenderedRow {
  row: OutlineRow;
  /** Position in the unfiltered list — the identity collapse state is keyed by. */
  key: string;
  selfEl: HTMLElement;
  childrenEl: HTMLElement | null;
  itemEl: HTMLElement;
}

export class OutlineView extends ItemView {
  private file: TFile | null = null;
  private rows: OutlineRow[] = [];
  private rendered: RenderedRow[] = [];
  private activeKey: string | null = null;
  private collapsed = new Set<string>();
  private allCollapsed = false;
  private followCursor = true;
  private query = "";
  private searchShown = false;

  private headerEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private search: SearchComponent | null = null;
  private searchWrapperEl: HTMLElement | null = null;
  private searchButtonEl: HTMLElement | null = null;
  private followButtonEl: HTMLElement | null = null;
  private collapseButtonEl: HTMLElement | null = null;
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
    return "Outline";
  }

  override async onOpen(): Promise<void> {
    this.buildChrome();

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.file = file;
        this.collapsed.clear();
        void this.render();
      }),
    );
    // A book's contents only become knowable once its reader has loaded it.
    this.registerEvent(
      this.events.onPosition((filePath, locator) => {
        if (filePath !== this.file?.path) return;
        if (this.rows.length === 0) void this.render();
        else this.highlightBookPosition(locator);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file === this.file) void this.render();
      }),
    );

    // `editor-selection-change` is an internal event. A plain DOM
    // selectionchange plus the public Editor.getCursor() is the supported
    // route to the same signal.
    const trackCursor = debounce(() => this.highlightCursorLine(), CURSOR_POLL_MS, true);
    this.registerDomEvent(document, "selectionchange", () => trackCursor());

    this.app.workspace.onLayoutReady(() => {
      this.file = this.app.workspace.getActiveFile();
      void this.render();
    });
  }

  // ---------------------------------------------------------------- chrome

  private buildChrome(): void {
    const headerEl = this.containerEl.createDiv({ cls: "nav-header" });
    // The header belongs above the scrolling content, not inside it.
    this.containerEl.insertBefore(headerEl, this.contentEl);
    this.headerEl = headerEl;

    const buttonsEl = headerEl.createDiv({ cls: "nav-buttons-container" });
    this.searchButtonEl = this.addNavButton(buttonsEl, "search", "Search", () => this.toggleSearch());
    this.followButtonEl = this.addNavButton(buttonsEl, "gallery-vertical", "Auto-scroll to current section", () =>
      this.toggleFollowCursor(),
    );
    this.collapseButtonEl = this.addNavButton(buttonsEl, "chevrons-down-up", "Collapse all", () => this.toggleCollapseAll());
    this.followButtonEl.toggleClass("is-active", this.followCursor);

    // SearchComponent builds its own `.search-input-container` inside whatever
    // parent it is given, but exposes only `inputEl`, so it gets a wrapper of
    // ours to show and hide.
    const searchWrapperEl = headerEl.createDiv();
    const search = new SearchComponent(searchWrapperEl);
    search.setPlaceholder("Filter…");
    search.onChange((value) => {
      this.query = value;
      void this.render();
    });
    searchWrapperEl.toggle(this.searchShown);
    this.searchWrapperEl = searchWrapperEl;
    this.search = search;

    this.contentEl.addClass("ereader-outline");
  }

  private addNavButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const el = parent.createDiv({ cls: "clickable-icon nav-action-button" });
    setIcon(el, icon);
    setTooltip(el, label);
    this.registerDomEvent(el, "click", onClick);
    return el;
  }

  private toggleSearch(): void {
    this.searchShown = !this.searchShown;
    this.searchButtonEl?.toggleClass("is-active", this.searchShown);
    this.searchWrapperEl?.toggle(this.searchShown);
    if (this.searchShown) {
      this.search?.inputEl.focus();
    } else if (this.query !== "") {
      this.search?.setValue("");
      this.query = "";
      void this.render();
    }
  }

  private toggleFollowCursor(): void {
    this.followCursor = !this.followCursor;
    this.followButtonEl?.toggleClass("is-active", this.followCursor);
    if (this.followCursor) this.scrollActiveIntoView();
  }

  private toggleCollapseAll(): void {
    this.allCollapsed = !this.allCollapsed;
    this.collapsed.clear();
    if (this.allCollapsed) {
      for (const item of this.rendered) {
        if (item.childrenEl) this.collapsed.add(item.key);
      }
    }
    setIcon(this.collapseButtonEl as HTMLElement, this.allCollapsed ? "chevrons-up-down" : "chevrons-down-up");
    setTooltip(this.collapseButtonEl as HTMLElement, this.allCollapsed ? "Expand all" : "Collapse all");
    this.applyCollapseState();
  }

  // ---------------------------------------------------------------- render

  private async render(): Promise<void> {
    if (this.renderScope) this.removeChild(this.renderScope);
    const scope = this.addChild(new Component());
    this.renderScope = scope;

    const container = this.contentEl;
    container.empty();
    this.rendered = [];
    this.activeKey = null;
    this.emptyEl = null;

    const file = this.file;
    if (!file) {
      this.rows = [];
      this.showEmpty("No headings found.");
      return;
    }

    const reader = activeReaderFor(this.app, file);
    const bookRows = reader ? rowsFromOutline(await reader.outline()) : [];
    if (this.file !== file) return; // the active file changed while we read

    this.rows = bookRows.length > 0 ? bookRows : this.noteRows(file);
    const visible = filterRows(this.rows, this.query);

    if (visible.length === 0) {
      this.showEmpty(
        this.rows.length > 0
          ? "No matching headings."
          : reader
            ? "This book has no table of contents, and the note has no headings."
            : "No headings found.",
      );
      return;
    }

    this.listEl = container.createDiv({ cls: "ereader-outline__list" });
    this.buildTree(scope, file, visible);
    this.applyCollapseState();

    if (bookRows.length > 0) this.highlightBookPosition(reader?.currentLocator() ?? null);
    else this.highlightCursorLine();
  }

  private showEmpty(text: string): void {
    this.emptyEl = this.contentEl.createDiv({ cls: "pane-empty", text });
  }

  /**
   * Builds nested `.tree-item` markup from the flat depth-tagged rows, so the
   * indentation and the indentation guide come from Obsidian's own
   * `.tree-item-children` rather than from arithmetic here.
   */
  private buildTree(scope: Component, file: TFile, visible: OutlineRow[]): void {
    const stack: { depth: number; containerEl: HTMLElement; parent: RenderedRow | null }[] = [
      { depth: -1, containerEl: this.listEl as HTMLElement, parent: null },
    ];

    visible.forEach((row, index) => {
      while (stack.length > 1 && (stack[stack.length - 1] as { depth: number }).depth >= row.depth) stack.pop();
      const top = stack[stack.length - 1] as { containerEl: HTMLElement; parent: RenderedRow | null };

      const itemEl = top.containerEl.createDiv({ cls: "tree-item" });
      const selfEl = itemEl.createDiv({ cls: "tree-item-self is-clickable" });
      const iconEl = selfEl.createDiv({ cls: "tree-item-icon collapse-icon" });
      selfEl.createDiv({ cls: "tree-item-inner", text: row.label });

      const rendered: RenderedRow = { row, key: `${row.depth}:${index}:${row.label}`, selfEl, childrenEl: null, itemEl };
      this.rendered.push(rendered);

      // A row is collapsible only once something nests under it, which is
      // only knowable when that child arrives — hence the deferred wiring.
      if (top.parent && top.parent.childrenEl === null) {
        this.makeCollapsible(scope, top.parent, iconEl);
      }

      selfEl.tabIndex = 0;
      scope.registerDomEvent(selfEl, "click", () => void this.openRow(file, row));
      scope.registerDomEvent(selfEl, "keydown", (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void this.openRow(file, row);
      });

      stack.push({ depth: row.depth, containerEl: itemEl, parent: rendered });
    });

    // The children containers are created lazily above; anything that never
    // got one is a leaf and keeps an empty icon slot for alignment.
    for (const item of this.rendered) {
      if (item.childrenEl === null) item.selfEl.addClass("mod-leaf");
    }
  }

  private makeCollapsible(scope: Component, parent: RenderedRow, _childIcon: HTMLElement): void {
    const childrenEl = parent.itemEl.createDiv({ cls: "tree-item-children" });
    // The child element was appended to itemEl before this container existed,
    // so move everything after the header row inside it.
    const nodes = Array.from(parent.itemEl.children).filter(
      (node) => node !== parent.selfEl && node !== childrenEl,
    );
    for (const node of nodes) childrenEl.appendChild(node);
    parent.childrenEl = childrenEl;

    parent.selfEl.addClass("mod-collapsible");
    const iconEl = parent.selfEl.querySelector<HTMLElement>(".collapse-icon");
    if (iconEl) {
      setIcon(iconEl, "right-triangle");
      scope.registerDomEvent(iconEl, "click", (event: MouseEvent) => {
        event.stopPropagation();
        this.toggleCollapsed(parent);
      });
    }
  }

  private toggleCollapsed(item: RenderedRow): void {
    if (this.collapsed.has(item.key)) this.collapsed.delete(item.key);
    else this.collapsed.add(item.key);
    this.applyCollapseState();
  }

  private applyCollapseState(): void {
    for (const item of this.rendered) {
      if (!item.childrenEl) continue;
      const isCollapsed = this.collapsed.has(item.key);
      item.itemEl.toggleClass("is-collapsed", isCollapsed);
      item.selfEl.querySelector(".collapse-icon")?.toggleClass("is-collapsed", isCollapsed);
    }
  }

  // ------------------------------------------------------------ highlight

  private noteRows(file: TFile): OutlineRow[] {
    const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
    return rowsFromHeadings(
      headings.map((heading) => ({ heading: heading.heading, level: heading.level, line: heading.position.start.line })),
    );
  }

  private highlightBookPosition(locator: Locator | null): void {
    const visible = filterRows(this.rows, this.query);
    this.setActive(activeRowIndex(visible, locator));
  }

  private highlightCursorLine(): void {
    if (this.rendered.length === 0 || this.rendered[0]?.row.target.kind !== "note") return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file !== this.file) return;
    const visible = filterRows(this.rows, this.query);
    this.setActive(activeRowIndexForLine(visible, view.editor.getCursor().line));
  }

  private setActive(index: number): void {
    const item = index >= 0 ? this.rendered[index] : undefined;
    if ((item?.key ?? null) === this.activeKey) return;
    for (const rendered of this.rendered) rendered.selfEl.removeClass("is-active");
    this.activeKey = item?.key ?? null;
    if (!item) return;
    item.selfEl.addClass("is-active");
    if (this.followCursor) this.scrollActiveIntoView();
  }

  private scrollActiveIntoView(): void {
    const active = this.rendered.find((item) => item.key === this.activeKey);
    active?.selfEl.scrollIntoView({ block: "nearest" });
  }

  // ----------------------------------------------------------- navigation

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
