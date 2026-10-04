// Search in the book: a query box, a running count, and the matches in
// reading order, each a jump to its place on the page.
//
// The panel owns the query and the results; the view supplies the search
// itself (the engine's), how to label a result, and what opening one means.
// A new query aborts the one before it, so typing never piles up searches.

import type { Component } from "obsidian";
import { Platform, debounce, setIcon, setTooltip } from "obsidian";
import { MAX_SEARCH_RESULTS, type SearchHandlers, type SearchHit } from "./search";

/** Shorter queries match too much of any book to be worth listing. */
const MIN_QUERY_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 250;

export interface SearchPanelCallbacks {
  search(query: string, handlers: SearchHandlers, signal: AbortSignal): Promise<void>;
  /** Where a result sits, for the line above its excerpt: a page, or a chapter. */
  label(hit: SearchHit): string;
  /** Goes to a result and marks it on the page. */
  open(hit: SearchHit): void;
  /** The panel closed; the mark on the page should go with it. */
  closed(): void;
}

interface RenderedHit {
  hit: SearchHit;
  el: HTMLElement;
}

export class SearchPanel {
  private readonly el: HTMLElement;
  private readonly inputEl: HTMLInputElement;
  private readonly statusEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly prevEl: HTMLElement;
  private readonly nextEl: HTMLElement;
  private hits: RenderedHit[] = [];
  private active = -1;
  private running: AbortController | null = null;
  private query = "";

  constructor(
    hostEl: HTMLElement,
    component: Component,
    private readonly callbacks: SearchPanelCallbacks,
  ) {
    this.el = hostEl.createDiv({ cls: "ereader-panel ereader-search", attr: { role: "search" } });
    this.el.hide();

    const header = this.el.createDiv({ cls: "ereader-search__header" });
    this.inputEl = header.createEl("input", {
      cls: "ereader-search__input",
      attr: { type: "search", placeholder: "Search in book", "aria-label": "Search in book", enterkeyhint: "search" },
    });
    this.prevEl = this.addButton(header, component, "chevron-up", "Previous result", () => this.step(-1));
    this.nextEl = this.addButton(header, component, "chevron-down", "Next result", () => this.step(1));
    this.addButton(header, component, "x", "Close search", () => this.hide());
    this.statusEl = this.el.createDiv({ cls: "ereader-search__status" });
    this.listEl = this.el.createDiv({ cls: "ereader-search__results" });

    const run = debounce(() => void this.run(this.inputEl.value), SEARCH_DEBOUNCE_MS, true);
    component.registerDomEvent(this.inputEl, "input", () => run());
    component.registerDomEvent(this.inputEl, "focus", () => this.el.removeClass("is-collapsed"));
    component.registerDomEvent(this.inputEl, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.hide();
      } else if (event.key === "Enter") {
        event.preventDefault();
        // Enter before the debounce fires searches at once; after, it steps.
        if (normalized(this.inputEl.value) !== this.query) void this.run(this.inputEl.value);
        else this.step(event.shiftKey ? -1 : 1);
      }
    });
    this.updateButtons();
  }

  isOpen(): boolean {
    return this.el.isShown();
  }

  open(): void {
    this.el.show();
    this.el.removeClass("is-collapsed");
    this.inputEl.focus();
    this.inputEl.select();
  }

  hide(): void {
    if (!this.isOpen()) return;
    this.running?.abort();
    this.running = null;
    this.el.hide();
    this.callbacks.closed();
  }

  /** Moves to the next or previous result, wrapping around the ends. */
  step(direction: 1 | -1): void {
    if (this.hits.length === 0) return;
    const next = this.active < 0 ? (direction === 1 ? 0 : this.hits.length - 1) : (this.active + direction + this.hits.length) % this.hits.length;
    this.select(next);
  }

  /** Drops the results, for a book that has been closed or replaced. */
  reset(): void {
    this.running?.abort();
    this.running = null;
    this.query = "";
    this.inputEl.value = "";
    this.clearResults();
    this.statusEl.setText("");
    this.el.hide();
  }

  private addButton(parent: HTMLElement, component: Component, icon: string, label: string, onClick: () => void): HTMLElement {
    const el = parent.createDiv({ cls: "clickable-icon ereader-search__button", attr: { "aria-label": label } });
    setIcon(el, icon);
    setTooltip(el, label);
    component.registerDomEvent(el, "click", onClick);
    return el;
  }

  private clearResults(): void {
    this.hits = [];
    this.active = -1;
    this.listEl.empty();
    this.updateButtons();
  }

  private async run(raw: string): Promise<void> {
    const query = normalized(raw);
    if (query === this.query && this.running) return;
    this.running?.abort();
    this.running = null;
    this.query = query;
    this.clearResults();
    if (query.length < MIN_QUERY_CHARS) {
      this.statusEl.setText(query === "" ? "" : "Type at least two characters.");
      return;
    }

    const controller = new AbortController();
    this.running = controller;
    this.statusEl.setText("Searching…");
    let capped = false;
    try {
      await this.callbacks.search(
        query,
        {
          hit: (hit) => {
            if (controller.signal.aborted) return false;
            this.addHit(hit);
            if (this.hits.length >= MAX_SEARCH_RESULTS) {
              capped = true;
              return false;
            }
            return true;
          },
          progress: (fraction) => {
            if (controller.signal.aborted) return;
            this.statusEl.setText(`Searching… ${Math.round(fraction * 100)}% · ${countLabel(this.hits.length)}`);
          },
        },
        controller.signal,
      );
    } catch (error) {
      console.error("[e-reader] search failed", error);
    }
    if (controller.signal.aborted) return;
    this.running = null;
    this.statusEl.setText(
      this.hits.length === 0
        ? "No results."
        : capped
          ? `The first ${MAX_SEARCH_RESULTS} results. Add a word to narrow it down.`
          : countLabel(this.hits.length),
    );
  }

  private addHit(hit: SearchHit): void {
    const index = this.hits.length;
    const el = this.listEl.createDiv({ cls: "ereader-search__result", attr: { tabindex: "0", role: "button" } });
    el.createDiv({ cls: "ereader-search__where", text: this.callbacks.label(hit) });
    const excerpt = el.createDiv({ cls: "ereader-search__excerpt" });
    excerpt.appendText(hit.before);
    excerpt.createEl("mark", { text: hit.exact });
    excerpt.appendText(hit.after);
    el.addEventListener("click", () => this.select(index));
    el.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.select(index);
    });
    this.hits.push({ hit, el });
    this.updateButtons();
  }

  private select(index: number): void {
    const item = this.hits[index];
    if (!item) return;
    this.hits[this.active]?.el.removeClass("is-active");
    this.active = index;
    item.el.addClass("is-active");
    item.el.scrollIntoView({ block: "nearest" });
    // A phone's panel covers the page; folding it down to the query row
    // shows the match while keeping the arrows to the next one.
    if (Platform.isPhone) {
      this.el.addClass("is-collapsed");
      this.inputEl.blur();
    }
    this.statusEl.setText(`${index + 1} of ${countLabel(this.hits.length)}`);
    this.callbacks.open(item.hit);
  }

  private updateButtons(): void {
    const none = this.hits.length === 0;
    this.prevEl.toggleClass("is-disabled", none);
    this.nextEl.toggleClass("is-disabled", none);
  }
}

function normalized(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function countLabel(count: number): string {
  return count === 1 ? "1 result" : `${count} results`;
}
