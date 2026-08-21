// The highlights & notes sidebar.
//
// It follows the active file exactly the way Obsidian's own Outline and
// Properties panes do — the `file-open` workspace event plus
// `getActiveFile()` — so it tracks the reader, a book note open in an
// editor, or anything else that reports a file, with no special casing.
//
// The note is the store, not this view: entries are read from the book note
// through the metadata cache on every change (FR-022), and every edit made
// here is written back to the note. Nothing is cached across renders beyond
// the current filter.

import type { TFile, WorkspaceLeaf } from "obsidian";
import { Component, ItemView, Menu, Notice, setIcon } from "obsidian";
import type { Entry, MalformedEntry } from "../annotations/entry";
import { listEntries, removeEntry, setEntryComment } from "../annotations/store";
import { compareLocators } from "../core/locator";
import { activeReaderFor, revealReader } from "./active-reader";

export const HIGHLIGHTS_VIEW_TYPE = "ereader-highlights";

const ALL_TYPES = "__all__";

/**
 * Reading order where both entries can say where they are, creation order
 * otherwise. An entry with no usable hint is unanchored (FR-024) and sorts
 * after everything that can be placed, rather than being dropped.
 */
function compareEntries(a: Entry, b: Entry): number {
  const hintA = a.anchor.hint;
  const hintB = b.anchor.hint;
  if (hintA && hintB) {
    const order = compareLocators(hintA, hintB);
    if (order !== null && order !== 0) return order;
  } else if (hintA && !hintB) {
    return -1;
  } else if (!hintA && hintB) {
    return 1;
  }
  return a.anchor.created.localeCompare(b.anchor.created);
}

export class HighlightsView extends ItemView {
  private file: TFile | null = null;
  private typeFilter: string = ALL_TYPES;
  /** Child component scoping one render pass's DOM listeners, replaced on the next render. */
  private renderScope: Component | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "highlighter";
    this.navigation = false;
  }

  override getViewType(): string {
    return HIGHLIGHTS_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "Highlights";
  }

  override async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.file = file;
        void this.render();
      }),
    );
    // The metadata cache is the sync channel: an entry edited by hand in the
    // note, or written by the reader, arrives here the same way.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file === this.file) void this.render();
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      this.file = this.app.workspace.getActiveFile();
      void this.render();
    });
  }

  private async render(): Promise<void> {
    // Every render rebuilds the DOM, so its listeners are scoped to a child
    // component that the next render disposes — registering them on the view
    // itself would accumulate a handler per entry per metadata change.
    if (this.renderScope) this.removeChild(this.renderScope);
    const scope = this.addChild(new Component());
    this.renderScope = scope;

    const container = this.contentEl;
    container.empty();
    container.addClass("ereader-highlights");

    const file = this.file;
    if (!file || file.extension !== "md") {
      container.createDiv({ cls: "pane-empty", text: "Open a book to see its highlights." });
      return;
    }

    const { entries, malformed } = await listEntries(this.app, file);
    if (this.file !== file) return; // the active file changed while we read

    this.renderFilter(scope, container, entries);

    const visible = entries
      .filter((entry) => this.typeFilter === ALL_TYPES || entry.type === this.typeFilter)
      .sort(compareEntries);

    if (visible.length === 0 && malformed.length === 0) {
      container.createDiv({ cls: "pane-empty", text: "No highlights yet." });
      return;
    }

    const listEl = container.createDiv({ cls: "ereader-highlights__list" });
    for (const entry of visible) {
      this.renderEntry(scope, listEl, file, entry);
    }
    for (const item of malformed) {
      this.renderMalformed(listEl, item);
    }
  }

  private renderFilter(scope: Component, container: HTMLElement, entries: Entry[]): void {
    const types = [...new Set(entries.map((entry) => entry.type))].sort();
    if (types.length === 0) return;

    const barEl = container.createDiv({ cls: "ereader-highlights__filters" });
    const addChip = (value: string, label: string): void => {
      const chip = barEl.createEl("button", { cls: "ereader-highlights__chip", text: label });
      chip.toggleClass("is-active", this.typeFilter === value);
      scope.registerDomEvent(chip, "click", () => {
        this.typeFilter = value;
        void this.render();
      });
    };
    addChip(ALL_TYPES, `All (${entries.length})`);
    for (const type of types) {
      addChip(type, `${type} (${entries.filter((entry) => entry.type === type).length})`);
    }
  }

  private renderEntry(scope: Component, listEl: HTMLElement, file: TFile, entry: Entry): void {
    const itemEl = listEl.createDiv({ cls: "ereader-highlights__entry" });
    itemEl.dataset["type"] = entry.type;
    if (!entry.anchor.hint) itemEl.addClass("is-unanchored");

    const headerEl = itemEl.createDiv({ cls: "ereader-highlights__header" });
    const iconEl = headerEl.createSpan({ cls: "ereader-highlights__icon" });
    setIcon(iconEl, entry.exact === "" ? "bookmark" : "highlighter");
    headerEl.createSpan({ cls: "ereader-highlights__type", text: entry.type });
    if (!entry.anchor.hint) {
      headerEl.createSpan({ cls: "ereader-highlights__badge", text: "unanchored" });
    }

    if (entry.exact !== "") {
      itemEl.createDiv({ cls: "ereader-highlights__quote", text: entry.exact });
    }

    const commentEl = itemEl.createDiv({ cls: "ereader-highlights__comment" });
    commentEl.setText(entry.comment);
    commentEl.dataset["placeholder"] = "Add a note…";
    commentEl.contentEditable = "true";
    commentEl.toggleClass("is-empty", entry.comment === "");
    scope.registerDomEvent(commentEl, "blur", () => {
      const next = (commentEl.textContent ?? "").trim();
      if (next === entry.comment) return;
      void setEntryComment(this.app, file, entry.id, next).catch((error: unknown) => {
        console.error("[e-reader] failed to save a comment", error);
        new Notice("E-Reader: could not save that note — see the console.");
      });
    });

    scope.registerDomEvent(itemEl, "click", (event) => {
      if (event.target instanceof HTMLElement && event.target.isContentEditable) return;
      void this.openEntry(file, entry, event.ctrlKey || event.metaKey);
    });
    scope.registerDomEvent(itemEl, "contextmenu", (event) => {
      event.preventDefault();
      this.showEntryMenu(event, file, entry);
    });
  }

  private renderMalformed(listEl: HTMLElement, item: MalformedEntry): void {
    const el = listEl.createDiv({ cls: "ereader-highlights__entry is-malformed" });
    el.createDiv({ cls: "ereader-highlights__type", text: item.id ?? "unreadable entry" });
    el.createDiv({ cls: "ereader-highlights__quote", text: item.reason });
  }

  /**
   * Clicking an entry scrolls the open reader to it. With a modifier — or
   * when no reader is open on this book — it opens the entry's block in the
   * note instead, which is also how a reader gets to the text they wrote.
   */
  private async openEntry(file: TFile, entry: Entry, preferNote: boolean): Promise<void> {
    const hint = entry.anchor.hint;
    if (!preferNote && hint) {
      const reader = activeReaderFor(this.app, file);
      if (reader) {
        revealReader(this.app, reader);
        await reader.goToLocator(hint);
        return;
      }
    }
    await this.app.workspace.openLinkText(`${file.path}#^${entry.id}`, file.path, false);
  }

  private showEntryMenu(event: MouseEvent, file: TFile, entry: Entry): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Copy block link")
        .setIcon("link")
        .onClick(() => {
          const link = this.app.fileManager.generateMarkdownLink(file, "", `#^${entry.id}`);
          void navigator.clipboard.writeText(link);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open in note")
        .setIcon("file-text")
        .onClick(() => void this.openEntry(file, entry, true)),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => {
          void removeEntry(this.app, file, entry.id).catch((error: unknown) => {
            console.error("[e-reader] failed to delete an entry", error);
            new Notice("E-Reader: could not delete that entry — see the console.");
          });
        }),
    );
    menu.showAtMouseEvent(event);
  }
}
