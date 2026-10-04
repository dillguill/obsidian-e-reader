// The reader's toolbar: the page buttons around a page box, then search,
// reading settings, contents and the bookmark.
//
// Zoom and the display options used to sit here too, shaped like Obsidian's
// own PDF toolbar. They now live in the reading-settings panel
// (appearance-panel.ts), which a phone needed anyway for want of room, so
// desktop and phone share one place for every setting.
//
// It does NOT reuse `.pdf-toolbar` / `.pdf-page-input`. Obsidian's generic
// chrome — `clickable-icon`, `setIcon`, `setTooltip` — is a supported
// styling surface and is used throughout, the same way
// sidebar/outline-view.ts borrows `.nav-header` and `.tree-item`. Those two
// classes are not generic: they belong to the PDF view specifically, and
// themes style them assuming a real PDF is behind them. The handful of layout
// rules is restated under `.ereader-toolbar*` in styles.css instead.
//
// The toolbar holds no state of its own. Everything it shows comes from
// `update(state)`, and every state is decided in toolbar-model.ts.

import type { Component } from "obsidian";
import { setIcon, setTooltip } from "obsidian";
import type { ToolbarState } from "./toolbar-model";
import { clampPageInput } from "./toolbar-model";

export interface ToolbarCallbacks {
  /** A value typed into the box: a page, or a percentage through a reflowable book. */
  goToPage(value: number): void;
  toggleBookmark(): void;
  turnPage(direction: 1 | -1): void;
  /** Opens the book's contents in the outline pane. */
  openContents(): void;
  toggleSearch(): void;
  /** Opens the reading-settings panel, anchored to the button that asked. */
  toggleAppearance(anchorEl: HTMLElement): void;
}

export class ReaderToolbar {
  private readonly rootEl: HTMLElement;
  private readonly pageInputEl: HTMLInputElement;
  private readonly pageCountEl: HTMLElement;
  private readonly bookmarkEl: HTMLElement;
  private readonly prevEl: HTMLElement;
  private readonly nextEl: HTMLElement;
  private readonly contentsEl: HTMLElement;
  /** The last value the box was given, restored when a typed entry is not a number. */
  private lastPageValue = "";

  constructor(parentEl: HTMLElement, component: Component, callbacks: ToolbarCallbacks) {
    this.rootEl = parentEl.createDiv({ cls: "ereader-toolbar" });
    const pageEl = this.rootEl.createDiv({ cls: "ereader-toolbar__group ereader-toolbar__pages" });
    this.prevEl = this.addButton(pageEl, component, "chevron-left", "Previous page", () => callbacks.turnPage(-1));
    this.pageInputEl = pageEl.createEl("input", {
      cls: "ereader-toolbar__page",
      attr: { type: "number", min: "1", inputmode: "numeric", "aria-label": "Page" },
    });
    this.pageCountEl = pageEl.createSpan({ cls: "ereader-toolbar__count" });
    this.nextEl = this.addButton(pageEl, component, "chevron-right", "Next page", () => callbacks.turnPage(1));

    component.registerDomEvent(this.pageInputEl, "click", () => this.pageInputEl.select());
    component.registerDomEvent(this.pageInputEl, "change", () => {
      const page = clampPageInput(this.pageInputEl.value, Number(this.pageInputEl.max), Number(this.pageInputEl.min));
      if (page === null) {
        this.pageInputEl.value = this.lastPageValue;
        return;
      }
      callbacks.goToPage(page);
    });

    // Highlighting has no button here: selecting text opens the selection
    // popup (selection-popup.ts), which is where the types live.
    const rightEl = this.rootEl.createDiv({ cls: "ereader-toolbar__group" });
    this.addButton(rightEl, component, "search", "Search in book", () => callbacks.toggleSearch());
    const appearanceEl = this.addButton(rightEl, component, "type", "Reading settings", () =>
      callbacks.toggleAppearance(appearanceEl),
    );
    this.contentsEl = this.addButton(rightEl, component, "list", "Contents", () => callbacks.openContents());
    this.bookmarkEl = this.addButton(rightEl, component, "bookmark", "Bookmark this page", () => callbacks.toggleBookmark());
  }

  private addButton(
    parentEl: HTMLElement,
    component: Component,
    icon: string,
    label: string,
    onClick: (event: MouseEvent) => void,
  ): HTMLElement {
    const el = parentEl.createDiv({ cls: "clickable-icon ereader-toolbar__button" });
    setIcon(el, icon);
    setTooltip(el, label);
    component.registerDomEvent(el, "click", onClick);
    return el;
  }

  update(state: ToolbarState): void {
    this.pageInputEl.disabled = !state.pageEnabled;
    // `min` and `max` are both the browser's bounds and where the change
    // handler reads them back from.
    this.pageInputEl.max = String(state.pageMax);
    this.pageInputEl.min = String(state.pageMin);
    this.pageInputEl.setAttr("aria-label", state.pageName);
    // Retyping the value while the box has focus would fight the reader.
    if (this.pageInputEl !== this.pageInputEl.doc.activeElement) {
      this.pageInputEl.value = state.pageValue;
    }
    this.lastPageValue = state.pageValue;
    this.pageCountEl.setText(state.pageLabel);

    this.prevEl.toggleClass("is-disabled", !state.canGoBack);
    this.nextEl.toggleClass("is-disabled", !state.canGoForward);

    this.bookmarkEl.toggleClass("is-active", state.bookmarked);
    setTooltip(this.bookmarkEl, state.bookmarked ? "Remove this bookmark" : "Bookmark this page");
  }

  /** The contents button follows the outline pane's own toggle in settings. */
  setContentsAvailable(available: boolean): void {
    this.contentsEl.toggle(available);
  }

  /** Hidden whenever there is no book to act on — a failed open, or no file. */
  setVisible(visible: boolean): void {
    this.rootEl.toggle(visible);
  }
}
