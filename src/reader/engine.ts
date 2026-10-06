// Contract both reader adapters implement (src/reader/epub/adapter.ts,
// src/reader/pdf/adapter.ts). No engine-specific type (epub.js's Book/
// Rendition, pdfjs's PDFDocumentProxy, ...) may appear outside its adapter
// module — callers (reader-view.ts, toolbar.ts) only ever see this interface.

import type { Locator } from "../core/types";
import type { SearchHandlers } from "./search";
import type { Typography } from "./typography";

export type { SearchHandlers } from "./search";

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
   * The id of the painted highlight under `position` (host-document client
   * coordinates), or null. An engine that cannot tell returns null and the
   * view hit-tests the painted overlay itself.
   */
  highlightAt(position: { x: number; y: number }): string | null;
  /** Facts about how the page is rendered, for the layout diagnostics command. */
  diagnostics(): Record<string, unknown>;
  /**
   * A paginated book's page was turned by the reader (a tap at the edge, a
   * swipe), or the reader swiped up or down on it — the gestures that stand
   * in for scrolling where nothing scrolls. An engine whose pages scroll
   * never calls it.
   */
  onPageGesture(handler: (gesture: "turn" | "up" | "down") => void): void;
  /**
   * Registers a handler for the end of a selection gesture inside the
   * rendered document — a mouse or touch release, NOT a settled selection.
   * The selection popup opens on the release itself rather than on a
   * debounced `selectionchange`, which would pop it up whenever a drag
   * paused halfway through.
   */
  onSelectionEnd(handler: () => void): void;
  /**
   * Registers a handler for every change to the selection inside the
   * rendered document, undebounced. This is how a selection adjusted by
   * dragging its handles on a touchscreen is noticed — those drags fire no
   * touch events into the page — and how a selection that has been cleared
   * takes the popup down with it.
   */
  onSelectionChange(handler: () => void): void;
  /**
   * The current selection's bounding box in the top window's client space,
   * or null when there is none. The same space the context-menu and tap
   * positions use, so the popup can be placed without knowing about iframes.
   */
  selectionRect(): { left: number; top: number; right: number; bottom: number } | null;
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
   * One step forward or back, the way a keyboard page turn means it: a page
   * (or a spread) for a fixed-page book, a page for a paginated EPUB, and a
   * screenful for a scrolled one — continuing into the next or previous
   * section once the current one runs out.
   */
  turnPage(direction: 1 | -1): Promise<void>;
  /**
   * Registers a handler for key presses inside documents the engine owns.
   * Key events do not cross an iframe boundary, so an EPUB's sections need
   * this to be heard at all; an engine that renders into the host document
   * can leave it unused, since the view's own Scope already sees its keys.
   * The handler returns whether it took the press, and only then is the
   * default suppressed.
   */
  onKeyDown(handler: (event: KeyboardEvent) => boolean): void;
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

  // -------------------------------------------------------------- search

  /**
   * Searches the whole book for `query`, reporting each match through
   * `handlers` as it is found, in reading order. Stops early when `signal`
   * aborts or `handlers.hit` returns false.
   */
  search(query: string, handlers: SearchHandlers, signal: AbortSignal): Promise<void>;

  // ---------------------------------------------------------- typography

  /** Font, spacing, margins and so on. A no-op for a fixed-layout book. */
  setTypography(typography: Typography): void;

  /**
   * Registers a handler fired just before the engine follows a link inside
   * the book, while it is still at the place the link was followed from, so
   * the reader can offer a way back. Engines without in-book links ignore it.
   */
  onLinkFollowed(handler: () => void): void;

  /** Releases the worker/listeners/object URLs this engine holds. Idempotent. */
  destroy(): void;
}
