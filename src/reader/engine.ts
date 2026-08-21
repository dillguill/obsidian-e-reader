// Contract both reader adapters implement (src/reader/epub/adapter.ts,
// src/reader/pdf/adapter.ts). No engine-specific type (epub.js's Book/
// Rendition, pdfjs's PDFDocumentProxy, ...) may appear outside its adapter
// module — callers (reader-view.ts) only ever see this interface.

import type { Locator } from "../core/types";

export interface OutlineNode {
  label: string;
  locator: Locator;
  children: OutlineNode[];
}

export interface SearchHit {
  excerpt: string;
  locator: Locator;
}

/** A selection inside the rendered document, ready to become an entry. */
export interface EngineSelection {
  exact: string;
  prefix: string;
  suffix: string;
  /** Where the selection sits, for the entry's `hint`. Null when the engine cannot say. */
  locator: Locator | null;
}

export interface ReaderEngine {
  /** Loads `file` and renders it into `container` (an element the caller owns). */
  open(path: string, container: HTMLElement): Promise<void>;
  goTo(locator: Locator): Promise<void>;
  /** Null before the first render has settled. */
  currentLocator(): Locator | null;
  /** 0–100. */
  progress(): number;
  outline(): Promise<OutlineNode[]>;
  search(query: string): Promise<SearchHit[]>;
  /**
   * The current selection inside the rendered document, or null when there
   * is none. Reading it is a poll rather than an event so callers decide
   * when a selection matters — a menu opening, a command running.
   */
  getSelection(): EngineSelection | null;
  /**
   * Registers a handler for a right-click inside the rendered document.
   * Coordinates are in the top window's client space, so callers can place
   * an Obsidian menu without knowing about iframes or text layers.
   */
  onContextMenu(handler: (position: { x: number; y: number }) => void): void;
  /** Releases the worker/listeners/object URLs this engine holds. Idempotent. */
  destroy(): void;
}
