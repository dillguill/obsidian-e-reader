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
import type { AnnotationType } from "../settings/settings-model";
import type { DisplayOption } from "./engine";
import type { ToolbarState } from "./toolbar-model";
import { clampPageInput } from "./toolbar-model";

export interface ToolbarCallbacks {
  zoomIn(): void;
  zoomOut(): void;
  goToPage(page: number): void;
  /** Read fresh each time the menu opens, so the ticks reflect the current state. */
  displayOptions(): DisplayOption[];
  /** Arms or disarms highlight mode. */
  toggleHighlightMode(): void;
  /** The configured types, read fresh so a change in settings shows up here. */
  annotationTypes(): readonly AnnotationType[];
  /** Chooses the type highlight mode writes, and arms it. */
  chooseHighlightType(name: string): void;
  toggleBookmark(): void;
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
  private readonly highlightEl: HTMLElement;
  private readonly bookmarkEl: HTMLElement;
  /** The last value the box was given, restored when a typed entry is not a number. */
  private lastPageValue = "";
  /** Name of the type the picker ticks. Kept so the menu can be built on demand. */
  private activeType = "";

  constructor(parentEl: HTMLElement, component: Component, callbacks: ToolbarCallbacks) {
    this.rootEl = parentEl.createDiv({ cls: "ereader-toolbar" });
    const leftEl = this.rootEl.createDiv({ cls: "ereader-toolbar__group" });

    this.zoomOutEl = this.addButton(leftEl, component, "zoom-out", "Zoom out", () => callbacks.zoomOut());
    leftEl.createDiv({ cls: "ereader-toolbar__divider" });
    this.zoomInEl = this.addButton(leftEl, component, "zoom-in", "Zoom in", () => callbacks.zoomIn());
    this.addButton(leftEl, component, "chevron-down", "Display options", (event) => {
      this.showDisplayOptions(event, callbacks.displayOptions());
    });

    leftEl.createDiv({ cls: "ereader-toolbar__spacer" });
    this.pageInputEl = leftEl.createEl("input", {
      cls: "ereader-toolbar__page",
      attr: { type: "number", min: "1", "aria-label": "Page" },
    });
    this.pageCountEl = leftEl.createSpan({ cls: "ereader-toolbar__count" });

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

    const rightEl = this.rootEl.createDiv({ cls: "ereader-toolbar__group" });
    this.highlightEl = this.addButton(rightEl, component, "highlighter", "Highlight mode", () =>
      callbacks.toggleHighlightMode(),
    );
    this.addButton(rightEl, component, "chevron-down", "Highlight type", (event) => {
      this.showTypePicker(event, callbacks);
    });
    this.bookmarkEl = this.addButton(rightEl, component, "bookmark", "Bookmark this page", () => callbacks.toggleBookmark());
  }

  /**
   * The type highlight mode writes, each shown in the colour it paints in.
   * MenuItem exposes no DOM element, so the swatch goes through `setTitle`'s
   * DocumentFragment form rather than by tinting an icon.
   */
  private showTypePicker(event: MouseEvent, callbacks: ToolbarCallbacks): void {
    const types = callbacks.annotationTypes();
    const menu = new Menu();
    if (types.length === 0) {
      menu.addItem((item) => item.setTitle("No highlight types configured").setDisabled(true));
    }
    for (const type of types) {
      const title = new DocumentFragment();
      const swatch = title.createSpan({ cls: "ereader-toolbar__swatch" });
      swatch.style.background = type.color;
      title.createSpan({ text: type.name });
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setChecked(type.name === this.activeType)
          .onClick(() => callbacks.chooseHighlightType(type.name)),
      );
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu.showAtPosition({ x: rect.x, y: rect.bottom });
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

    this.activeType = state.activeType;
    this.highlightEl.toggleClass("is-active", state.highlightMode);
    // The armed colour reads off the button itself, so it is obvious which
    // type a drag is about to become.
    this.highlightEl.style.setProperty("--ereader-active-hl", state.activeColor);
    setTooltip(
      this.highlightEl,
      state.highlightMode
        ? `Highlighting as "${state.activeType}" — click to stop`
        : state.activeType === ""
          ? "Highlight mode (no types configured)"
          : `Highlight mode — writes "${state.activeType}"`,
    );

    this.bookmarkEl.toggleClass("is-active", state.bookmarked);
    setTooltip(this.bookmarkEl, state.bookmarked ? "Remove this bookmark" : "Bookmark this page");
  }

  /** Hidden whenever there is no book to act on — a failed open, or no file. */
  setVisible(visible: boolean): void {
    this.rootEl.toggle(visible);
  }
}
