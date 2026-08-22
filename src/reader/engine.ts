// Contract both reader adapters implement (src/reader/epub/adapter.ts,
// src/reader/pdf/adapter.ts). No engine-specific type (epub.js's Book/
// Rendition, pdfjs's PDFDocumentProxy, ...) may appear outside its adapter
// module — callers (reader-view.ts, toolbar.ts) only ever see this interface.

import type { Locator } from "../core/types";

export interface OutlineNode {
  label: string;
  locator: Locator;
  children: OutlineNode[];
}

/** A selection inside the rendered document, ready to become an entry. */
export interface EngineSelection {
  exact: string;
  prefix: string;
  suffix: string;
  /** Where the selection sits, for the entry's `hint`. Null when the engine cannot say. */
  locator: Locator | null;
}

/**
 * Where the reader is, as a number the toolbar can show and accept. A PDF
 * counts real pages; an EPUB has none, so it counts epub.js's generated
 * locations — a stable index through the book that behaves the same way.
 */
export interface PageState {
  /** 1-based. */
  current: number;
  total: number;
  unit: "page" | "location";
}

/**
 * One item in the toolbar's display-options menu. Each adapter declares its
 * own — fit modes and spreads for a fixed-page book, flow and theme for a
 * reflowable one — so the toolbar can render the menu without knowing that
 * either concept exists.
 */
export interface DisplayOption {
  section: "zoom" | "spread" | "layout" | "appearance";
  /** Stable identity, for tests and for keying the menu item. */
  id: string;
  label: string;
  icon: string;
  checked: boolean;
  apply(): void | Promise<void>;
}

/** A saved entry the engine is being asked to draw into the document. */
export interface PaintedHighlight {
  id: string;
  type: string;
  exact: string;
  prefix?: string;
  suffix?: string;
  /** The recorded position. A fast path only — the quoted text is the authority. */
  hint?: Locator;
  /**
   * The colour to draw it in, already resolved from the reader's configured
   * types. Engines do not read settings or the theme themselves: an EPUB's
   * overlay lives inside an iframe and a PDF's boxes are positioned in JS, so
   * neither can be reached by styles.css and both need a concrete value.
   */
  color: string;
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
   *
   * The handler returns whether it took the event. Only then is the default
   * suppressed — which matters on a touchscreen, where a long press both
   * fires `contextmenu` AND starts the platform's own text selection, so
   * claiming one that was meant to select text destroys the selection.
   */
  onContextMenu(handler: (position: { x: number; y: number }) => boolean): void;
  /**
   * Registers a handler for a plain click or tap inside the rendered
   * document, in the top window's client space.
   *
   * This is how an existing highlight is reached on a touchscreen. A long
   * press cannot be: iOS has not fired `contextmenu` on one since iOS 13, so
   * the press never reaches the reader at all, and on the platforms where it
   * does fire it is also the gesture that starts a text selection. A tap is
   * unambiguous and is synthesised from a touch everywhere. It is what
   * foliate-js does (view.js hit-tests its overlayer on `click`) and what
   * epub.js's annotation API assumes (`annotations.highlight` takes a click
   * callback).
   *
   * The handler decides whether the tap landed on anything; taps that hit
   * nothing are ordinary reading and must stay that way.
   */
  onTap(handler: (position: { x: number; y: number }) => void): void;
  /**
   * Registers a handler for the end of a selection gesture inside the
   * rendered document — a mouse or touch release, NOT a settled selection.
   * The reader's highlight mode turns a release into a highlight, so the
   * signal has to be the release itself: epub.js's own `selected` event fires
   * off a 250ms `selectionchange` debounce, which means pausing mid-drag
   * would highlight half of what the reader was still selecting.
   */
  onSelectionEnd(handler: () => void): void;
  /**
   * Drops the current selection inside the rendered document. The selection
   * belongs to whichever document the engine rendered into — an EPUB's
   * iframe, the host document for a PDF — so only the engine can reach it.
   */
  clearSelection(): void;

  // ------------------------------------------------------------- toolbar

  /** Null until the engine knows where it is — an EPUB's index is built in the background. */
  pageState(): PageState | null;
  /** Jumps to a 1-based page (PDF) or location (EPUB). Out-of-range values clamp. */
  goToPage(page: number): Promise<void>;
  /**
   * The page/location number a locator falls on, so the toolbar can tell
   * whether the current place is already bookmarked. Null when the locator
   * is for another format, or the engine cannot place it.
   */
  pageNumberFor(locator: Locator): number | null;
  /** Zoom (PDF) or text size (EPUB) as a multiplier of the engine's base; 1 = actual size. */
  scale(): number;
  setScale(scale: number): Promise<void>;
  /** Items for the toolbar's display-options menu. Re-read each time the menu opens. */
  displayOptions(): DisplayOption[];
  /**
   * Registers a handler fired whenever the rendered position or the scale
   * changed. The toolbar refreshes from this rather than polling — the
   * reader's own 2-second position flush is far too slow for a page counter.
   */
  onChange(handler: () => void): void;

  // ---------------------------------------------------------- highlights

  /**
   * Draws these highlights into the rendered document, replacing whatever was
   * drawn before. An empty list clears them. Entries whose quoted text cannot
   * be found are skipped, never guessed at (FR-024).
   */
  paintHighlights(highlights: readonly PaintedHighlight[]): Promise<void>;

  /**
   * Re-applies anything derived from the vault's theme. Called on Obsidian's
   * `css-change`. A no-op for engines that render in the host document.
   */
  refreshTheme(): void;

  /** Releases the worker/listeners/object URLs this engine holds. Idempotent. */
  destroy(): void;
}
