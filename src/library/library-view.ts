// The `library` Bases view. Renders from `this.data.groupedData` so
// whatever groupBy/sort/filter the user configured in Bases is honoured —
// this class never filters, sorts, searches, or groups on its own, and
// never writes to the vault; opening a book is a pure `openLinkText` call.

import type { BasesEntry, QueryController } from "obsidian";
import { BasesView, Component } from "obsidian";
import { renderCard } from "./card";
import { type OpenBookModifiers, decideOpenTarget } from "./open-book";
import { readLibraryViewConfig } from "./view-config";

export const LIBRARY_VIEW_TYPE = "library";

export class LibraryView extends BasesView {
  type = LIBRARY_VIEW_TYPE;

  private readonly containerEl: HTMLElement;
  private rootEl: HTMLElement;
  /** Child component scoping one render pass's DOM event registrations, torn down and replaced on the next render. */
  private renderScope: Component | null = null;

  constructor(controller: QueryController, containerEl: HTMLElement) {
    super(controller);
    this.containerEl = containerEl;
    this.rootEl = containerEl.createDiv({ cls: "ereader-library" });
  }

  onDataUpdated(): void {
    try {
      this.render();
    } catch (error) {
      console.error("[e-reader] library view render failed", error);
      this.rootEl.empty();
      this.rootEl.createDiv({ text: `E-Reader: render failed — ${String(error)}` });
    }
  }

  private render(): void {
    if (this.renderScope) {
      this.removeChild(this.renderScope);
    }
    const scope = this.addChild(new Component());
    this.renderScope = scope;

    this.rootEl.empty();
    const libConfig = readLibraryViewConfig(this.config);
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

      for (const entry of group.entries) {
        const card = renderCard(this.app, entry, this.config, libConfig);
        gridEl.appendChild(card);

        scope.registerDomEvent(card, "click", (evt: MouseEvent) => {
          this.openBook(entry, { ctrlKey: evt.ctrlKey, metaKey: evt.metaKey, altKey: evt.altKey, button: evt.button });
        });
        scope.registerDomEvent(card, "keydown", (evt: KeyboardEvent) => {
          if (evt.key !== "Enter" && evt.key !== " ") return;
          evt.preventDefault();
          this.openBook(entry, { ctrlKey: evt.ctrlKey, metaKey: evt.metaKey, altKey: evt.altKey });
        });
      }
    }
  }

  /**
   * Opens the book itself — the first readable attachment listed on the note —
   * rather than the note. Falls back to the note when there is nothing to read.
   */
  private openBook(entry: BasesEntry, modifiers: OpenBookModifiers): void {
    const target = decideOpenTarget(modifiers);
    const newLeaf = target === "same-tab" ? false : target === "split" ? "split" : true;
    const book = this.resolveBookFile(entry) ?? entry.file.path;
    void this.app.workspace.openLinkText(book, entry.file.path, newLeaf);
  }

  private resolveBookFile(entry: BasesEntry): string | null {
    const cache = this.app.metadataCache.getFileCache(entry.file);
    const attachments = cache?.frontmatter?.["attachments"];
    const list: unknown[] = Array.isArray(attachments) ? attachments : attachments ? [attachments] : [];
    for (const item of list) {
      if (typeof item !== "string") continue;
      const linkpath = item.replace(/^\[\[|\]\]$/g, "").split("|")[0]?.trim();
      if (!linkpath) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath, entry.file.path);
      if (dest && (dest.extension === "epub" || dest.extension === "pdf")) return dest.path;
    }
    return null;
  }
}
