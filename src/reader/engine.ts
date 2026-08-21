// Contract both reader adapters implement (src/reader/epub/adapter.ts,
// src/reader/pdf/adapter.ts). No engine-specific type (epub.js's Book/
// Rendition, pdfjs's PDFDocumentProxy, ...) may appear outside its adapter
// module — callers (reader-view.ts) only ever see this interface.

import type { TFile } from "obsidian";
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
  /** Releases the worker/listeners/object URLs this engine holds. Idempotent. */
  destroy(): void;
}
