// The reader's toolbar.
//
// It deliberately mirrors the layout of Obsidian's own PDF toolbar — zoom
// out, a divider, zoom in, a display-options dropdown, then the page box —
// which was read from the shipped app (obsidian-1.13.7.asar → app.js's
// `pdf-toolbar` builder, app.css's `.pdf-toolbar` block) rather than guessed
// at, so that this plugin's reader feels like part of the app rather than a
// second, differently-shaped one.
//
// What it does NOT do is reuse `.pdf-toolbar` / `.pdf-page-input`. Obsidian's
// generic chrome — `clickable-icon`, `setIcon`, `setTooltip`, `Menu` — is a
// supported styling surface and is used throughout, the same way
// sidebar/outline-view.ts borrows `.nav-header` and `.tree-item`. Those two
// classes are not generic: they belong to the PDF view specifically, and
// themes style them assuming a real PDF is behind them. The handful of layout
// rules is restated under `.ereader-toolbar*` in styles.css instead.
//
// The toolbar holds no state of its own. Everything it shows comes from
// `update(state)`, and every state is decided in toolbar-model.ts.

import type { Component } from "obsidian";
import { Menu, setIcon, setTooltip } from "obsidian";
import type { DisplayOption } from "./engine";
import type { ToolbarState } from "./toolbar-model";
import { clampPageInput } from "./toolbar-model";

export interface ToolbarCallbacks {
  zoomIn(): void;
  zoomOut(): void;
  goToPage(page: number): void;
  /** Read fresh each time the menu opens, so the ticks reflect the current state. */
  displayOptions(): DisplayOption[];
  toggleBookmark(): void;
  turnPage(direction: 1 | -1): void;
  /** Opens the book's contents in the outline pane. */
  openContents(): void;
  toggleSearch(): void;
  /** Opens the reading-settings panel, anchored to the button that asked. */
  toggleAppearance(anchorEl: HTMLElement): void;
}

/**
 * Menu sections, in the order they appear. Obsidian's Menu draws a separator
 * between sections and orders them by first appearance — its `addSections`,
 * which would declare the order up front, is not in the public API — so the
 * options are sorted into this order before being added.
 */
const SECTIONS: DisplayOption["section"][] = ["zoom", "spread", "layout", "appearance"];

export class ReaderToolbar {
  private readonly rootEl: HTMLElement;
  private readonly zoomOutEl: HTMLElement;
  private readonly zoomInEl: HTMLElement;
  private readonly pageInputEl: HTMLInputElement;
  private readonly pageCountEl: HTMLElement;
  private readonly bookmarkEl: HTMLElement;
  private readonly prevEl: HTMLElement;
  private readonly nextEl: HTMLElement;
  private readonly progressBarEl: HTMLElement;
  private readonly contentsEl: HTMLElement;
  /** The last value the box was given, restored when a typed entry is not a number. */
  private lastPageValue = "";

  constructor(parentEl: HTMLElement, component: Component, callbacks: ToolbarCallbacks) {
    this.rootEl = parentEl.createDiv({ cls: "ereader-toolbar" });
    const leftEl = this.rootEl.createDiv({ cls: "ereader-toolbar__group" });

    // On a phone the zoom pair is hidden by styles.css — pinching does the
    // same, and the display menu carries both — to leave room for the page
    // buttons, which a touchscreen has no other way to reach.
    const zoomEl = leftEl.createDiv({ cls: "ereader-toolbar__group ereader-toolbar__zoom" });
    this.zoomOutEl = this.addButton(zoomEl, component, "zoom-out", "Zoom out", () => callbacks.zoomOut());
    zoomEl.createDiv({ cls: "ereader-toolbar__divider" });
    this.zoomInEl = this.addButton(zoomEl, component, "zoom-in", "Zoom in", () => callbacks.zoomIn());
    // A phone hides this too: its items move into the reading-settings panel.
    this.addButton(leftEl, component, "chevron-down", "Display options", (event) => {
      this.showDisplayOptions(event, callbacks.displayOptions());
    }).addClass("ereader-toolbar__display");

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
      const total = Number(this.pageInputEl.max);
      const page = clampPageInput(this.pageInputEl.value, total);
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

    // How far through the book, along the toolbar's bottom edge.
    const trackEl = this.rootEl.createDiv({ cls: "ereader-toolbar__track", attr: { "aria-hidden": "true" } });
    this.progressBarEl = trackEl.createDiv({ cls: "ereader-toolbar__bar" });
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

  private showDisplayOptions(event: MouseEvent, options: DisplayOption[]): void {
    if (options.length === 0) return;
    const menu = new Menu();
    const ordered = [...options].sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));
    for (const option of ordered) {
      menu.addItem((item) =>
        item
          .setSection(option.section)
          .setIcon(option.icon)
          .setTitle(option.label)
          .setChecked(option.checked)
          .onClick(() => void option.apply()),
      );
    }
    // Anchored under the button, the way the native toolbar's own dropdowns are.
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.showAtPosition({ x: rect.x, y: rect.bottom });
  }

  update(state: ToolbarState): void {
    this.zoomOutEl.toggleClass("is-disabled", !state.canZoomOut);
    this.zoomInEl.toggleClass("is-disabled", !state.canZoomIn);

    this.pageInputEl.disabled = !state.pageEnabled;
    // `max` is both the browser's bound and where the change handler reads
    // the document's length back from.
    this.pageInputEl.max = String(state.pageTotal);
    // Retyping the value while the box has focus would fight the reader.
    if (this.pageInputEl !== this.pageInputEl.doc.activeElement) {
      this.pageInputEl.value = state.pageValue;
    }
    this.lastPageValue = state.pageValue;
    this.pageCountEl.setText(state.pageLabel);

    this.prevEl.toggleClass("is-disabled", !state.canGoBack);
    this.nextEl.toggleClass("is-disabled", !state.canGoForward);
    this.progressBarEl.setCssStyles({ width: `${state.progressFraction * 100}%` });

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
