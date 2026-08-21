// EPUB adapter: epub.js, bundled straight into main.js (see
// esbuild.config.mjs — no vendor dir, no vault.adapter.getResourcePath()
// resource-path resolution) and imported dynamically so none of it is
// evaluated until an EPUB is opened, as Principle V requires.
//
// That earlier "Failed to fetch dynamically imported module" was caused by
// importing an unbundled file by relative path, which resolved against the
// app origin. With `format: "cjs"` and `splitting: false` esbuild keeps the
// module inside main.js and only defers its evaluation, so nothing is
// fetched at runtime and the failure cannot recur.
//
// epub.js's own .d.ts (node_modules/epubjs/types) is incomplete/wrong in
// places verified against node_modules/epubjs/src (e.g. Section.find's
// declared return type of Element[] doesn't match its actual {cfi, excerpt}[]
// return — see section.js's find()). This module declares its own minimal,
// verified contract for the pieces it uses and casts epub.js's runtime
// objects onto it, rather than trusting the shipped types outright. No
// epub.js type may leak past this module — callers only see
// ReaderEngine/OutlineNode/SearchHit/... (../engine.ts).

import type { App } from "obsidian";
import type { Locator } from "../../core/types";
import type { EpubFlow } from "../../settings/settings-model";
import { activeRange, rangeForQuote, searchableText, snapshotFromRange } from "../dom-selection";
import type { DisplayOption, EngineSelection, OutlineNode, PageState, PaintedHighlight, ReaderEngine, SearchHit } from "../engine";
import { highlightColor } from "../highlight-style";
import { fractionToPercent } from "../progress";
import { clampScale } from "../zoom";

interface EpubNavItem {
  label: string;
  href: string;
  subitems?: EpubNavItem[];
}

interface EpubNavigation {
  toc: EpubNavItem[];
}

interface EpubSectionMatch {
  cfi: string;
  excerpt: string;
}

/** epub.js's Section (book.spine.get(...) / book.spine.spineItems entries). */
interface EpubSection {
  load(request: (url: string) => Promise<unknown>): Promise<Element>;
  unload(): void;
  find(query: string): EpubSectionMatch[];
  cfiFromElement(el: Element): string;
}

interface EpubSpine {
  get(target: string): EpubSection | null;
  spineItems: EpubSection[];
}

/**
 * epub.js's Locations. `total` and the location index are 0-based
 * (locations.js: `this.total = this._locations.length - 1`), and both are 0
 * until `generate()` settles — `locationFromCfi` returns -1 in the meantime.
 */
interface EpubLocations {
  generate(chars: number): Promise<string[]>;
  percentageFromCfi(cfi: string): number;
  locationFromCfi(cfi: string): number;
  /** The CFI at a 0-based location index, or the number -1 when out of range. */
  cfiFromLocation(location: number): string | number;
  total: number;
}

interface EpubBook {
  ready: Promise<unknown>;
  navigation: EpubNavigation;
  spine: EpubSpine;
  locations: EpubLocations;
  /** Archive-aware URL loader — the `request` fn Section.load needs to read from the .epub's zip rather than attempt an HTTP fetch. */
  load(url: string): Promise<unknown>;
  renderTo(element: HTMLElement, options?: Record<string, unknown>): EpubRendition;
  destroy(): void;
}

interface EpubDisplayedLocation {
  cfi: string;
}

interface EpubCurrentLocation {
  start: EpubDisplayedLocation;
}

/** One rendered section's iframe document (epub.js Contents). */
interface EpubContents {
  document: Document;
  window: Window;
  cfiFromRange(range: Range): string;
}

interface EpubHook {
  register(fn: (contents: EpubContents) => void): void;
}

/** epub.js's Themes. `fontSize` is an override, so it re-applies to sections as they render. */
interface EpubThemes {
  fontSize(size: string): void;
}

/** epub.js's Annotations (annotations.js). `remove` is keyed by cfiRange + type. */
interface EpubAnnotations {
  highlight(cfiRange: string, data?: unknown, cb?: unknown, className?: string, styles?: Record<string, string>): unknown;
  remove(cfiRange: string, type: string): void;
}

interface EpubRendition {
  display(target?: string): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  on(event: "relocated", callback: (location: EpubCurrentLocation) => void): void;
  /** `hooks.content` runs for each section as it is rendered, giving access to its iframe document. */
  hooks: { content: EpubHook };
  getContents(): EpubContents[];
  themes: EpubThemes;
  annotations: EpubAnnotations;
  flow(flow: string): void;
  destroy(): void;
}

/** Preferences this engine owns, handed in at construction and reported back on change. */
export interface EpubPreferences {
  textScale: number;
  flow: EpubFlow;
}

export interface EpubEngineOptions extends EpubPreferences {
  onPreferencesChanged(preferences: EpubPreferences): void;
}

/**
 * Resolves a TOC entry's href to a real CFI by briefly loading that
 * section's document and asking epub.js for a CFI at its root element, then
 * unloading it again. epub.js's navigation.toc only carries hrefs, but this
 * plugin's Locator (core/types.ts) is CFI-only — see locator.ts's EPUB_RE —
 * so outline entries need converting once, up front, rather than deferring
 * to a href-based Locator variant.
 */
async function cfiForHref(book: EpubBook, href: string): Promise<string | null> {
  const section = book.spine.get(href);
  if (!section) return null;
  try {
    const root = await section.load((url) => book.load(url));
    return section.cfiFromElement(root);
  } catch (error) {
    console.error("[e-reader] failed to resolve TOC entry to a CFI", href, error);
    return null;
  } finally {
    section.unload();
  }
}

async function outlineFromToc(book: EpubBook, items: EpubNavItem[]): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = [];
  for (const item of items) {
    const cfi = await cfiForHref(book, item.href);
    if (cfi === null) continue;
    const children = item.subitems && item.subitems.length > 0 ? await outlineFromToc(book, item.subitems) : [];
    nodes.push({ label: item.label, locator: { kind: "epub", cfi }, children });
  }
  return nodes;
}

const LOCATIONS_GENERATE_CHARS = 1600;

/**
 * How far into a page a tap counts as "go back" / "go forward". The middle is
 * left alone so a tap can still dismiss a selection or follow a link.
 */
const TAP_ZONE = 0.3;

/** A tap that moved this far is a drag — a selection, not a page turn. */
const TAP_SLOP_PX = 8;

/**
 * How far past the end of a chapter the reader has to keep pushing before it
 * turns. A chapter shorter than the pane — a dedication, an epigraph — is at
 * its top AND its bottom from the moment it loads, so "you are at the end"
 * cannot be the trigger on its own: a single flick would step into such a
 * chapter and straight back out of it.
 */
const OVERSCROLL_THRESHOLD_PX = 160;

/** A gesture is over once no scroll event has arrived for this long. */
const GESTURE_IDLE_MS = 180;

/**
 * epub.js's name for each of our flow modes.
 *
 * `scrolled-doc` renders ONE section at a time, completely. That is the whole
 * point: the continuous manager has to estimate every section's height before
 * rendering it, then corrects the container as the real heights arrive, which
 * moves the scroll position under the reader and can push the section being
 * read out of the render window — text flickering in and out, and scrolling
 * that fights back (issue #38). A manager that renders one whole section has
 * nothing to estimate, so the problem cannot occur rather than merely
 * occurring less.
 */
function epubFlow(mode: EpubFlow): string {
  return mode === "paginated" ? "paginated" : "scrolled-doc";
}

/** Marks the `<style>` element this plugin owns inside each rendered section. */
const THEME_STYLE_ID = "ereader-theme";

/** Loads epub.js on first use; the promise is cached across books. */
let epubjsPromise: Promise<(input: ArrayBuffer) => unknown> | null = null;

function loadEpubjs(): Promise<(input: ArrayBuffer) => unknown> {
  epubjsPromise ??= import("epubjs").then((module) => module.default as unknown as (input: ArrayBuffer) => unknown);
  return epubjsPromise;
}

export class EpubEngine implements ReaderEngine {
  private book: EpubBook | null = null;
  private rendition: EpubRendition | null = null;
  private container: HTMLElement | null = null;
  private lastCfi: string | null = null;
  private contextMenuHandler: ((position: { x: number; y: number }) => void) | null = null;
  private changeHandler: (() => void) | null = null;
  private textScale: number;
  private flowMode: EpubFlow;
  private highlights: readonly PaintedHighlight[] = [];
  /** Every CFI range currently drawn, so a repaint can take them all down first. */
  private paintedRanges = new Set<string>();
  /** Set while a page/chapter turn is in flight, so repeat gestures do not stack. */
  private turning = false;
  /** Scroll travel accumulated past the end of the chapter, in pixels. */
  private overscroll = 0;
  /**
   * Set after a turn and cleared only once scrolling actually STOPS. Trackpad
   * and touch inertia keep firing for a second or more after the reader has
   * let go, and without this that one flick would chain through several
   * chapters — which is exactly what a short chapter made obvious.
   */
  private turnBlocked = false;
  private gestureIdleTimer: number | null = null;

  constructor(
    private readonly app: App,
    private readonly options: EpubEngineOptions,
  ) {
    this.textScale = clampScale(options.textScale);
    this.flowMode = options.flow;
  }

  async open(path: string, container: HTMLElement): Promise<void> {
    this.destroy();

    const ePub = await loadEpubjs();
    const data = await this.app.vault.adapter.readBinary(path);
    const book = ePub(data) as unknown as EpubBook;
    this.book = book;
    this.container = container;
    await book.ready;

    // Default flow renders one section at a time, which lands on the cover and
    // stops. Continuous + scrolled gives a single scrollable book.
    const rendition = book.renderTo(container, {
      width: "100%",
      height: "100%",
      manager: "default",
      flow: epubFlow(this.flowMode),
      allowScriptedContent: false,
    });
    this.rendition = rendition;
    rendition.on("relocated", (location) => {
      this.lastCfi = location.start.cfi;
      this.changeHandler?.();
    });

    // Events inside an iframe do not cross into the host document, so the
    // context-menu listener has to be attached per rendered section. `hooks.
    // content` is epub.js's own extension point for exactly this, and runs
    // again for every section the continuous manager brings in.
    rendition.hooks.content.register((contents) => {
      contents.document.addEventListener("contextmenu", (event: MouseEvent) => {
        const handler = this.contextMenuHandler;
        if (!handler) return;
        event.preventDefault();
        const frame = contents.window.frameElement;
        const frameRect = frame?.getBoundingClientRect();
        handler({
          x: event.clientX + (frameRect?.left ?? 0),
          y: event.clientY + (frameRect?.top ?? 0),
        });
      });
      this.addNavigationGestures(contents);
      // A section that arrives later still gets the vault's theme and
      // whatever highlights belong to it.
      this.styleContents(contents);
      this.paintContents(contents);
    });

    rendition.themes.fontSize(`${Math.round(this.textScale * 100)}%`);
    // The other half of the pair described on addScrollIntentListeners: this
    // covers everything in the pane that is NOT the section's iframe.
    this.addScrollIntentListeners(container);
    await rendition.display();

    // Whole-book percentage needs the character-offset index epub.js builds
    // by walking every section; that's too slow to block open() on, so it
    // runs in the background and progress() degrades to 0 until it settles.
    void book.locations
      .generate(LOCATIONS_GENERATE_CHARS)
      .then(() => this.changeHandler?.())
      .catch((error: unknown) => {
        console.error("[e-reader] failed to generate epub locations", error);
      });
  }

  async goTo(locator: Locator): Promise<void> {
    if (!this.rendition || locator.kind !== "epub") return;
    await this.rendition.display(locator.cfi);
  }

  currentLocator(): Locator | null {
    return this.lastCfi === null ? null : { kind: "epub", cfi: this.lastCfi };
  }

  progress(): number {
    if (!this.book || this.lastCfi === null) return 0;
    const fraction = this.book.locations.percentageFromCfi(this.lastCfi);
    return Number.isFinite(fraction) ? fractionToPercent(fraction) : 0;
  }

  // ------------------------------------------------------------ toolbar

  /**
   * An EPUB has no pages, so the toolbar counts epub.js's generated
   * locations instead. They are 0-based internally and presented 1-based, and
   * do not exist at all until `generate()` settles — until then this reports
   * null and the toolbar's box stays disabled rather than showing a lie.
   */
  pageState(): PageState | null {
    const locations = this.book?.locations;
    if (!locations || locations.total <= 0 || this.lastCfi === null) return null;
    const at = locations.locationFromCfi(this.lastCfi);
    if (at < 0) return null;
    return { current: at + 1, total: locations.total + 1, unit: "location" };
  }

  async goToPage(page: number): Promise<void> {
    const locations = this.book?.locations;
    if (!this.rendition || !locations || locations.total <= 0) return;
    const index = Math.min(Math.max(0, Math.round(page) - 1), locations.total);
    const cfi = locations.cfiFromLocation(index);
    if (typeof cfi !== "string") return;
    await this.rendition.display(cfi);
  }

  pageNumberFor(locator: Locator): number | null {
    const locations = this.book?.locations;
    if (!locations || locator.kind !== "epub" || locations.total <= 0) return null;
    const at = locations.locationFromCfi(locator.cfi);
    return at < 0 ? null : at + 1;
  }

  scale(): number {
    return this.textScale;
  }

  async setScale(scale: number): Promise<void> {
    const next = clampScale(scale);
    if (next === this.textScale) return;
    this.textScale = next;
    this.rendition?.themes.fontSize(`${Math.round(next * 100)}%`);
    this.options.onPreferencesChanged({ textScale: this.textScale, flow: this.flowMode });
    this.changeHandler?.();
    // Reflowing moves every CFI-anchored box; epub.js redraws its own
    // annotations, but the quote-to-range search has to run again.
    await this.paintHighlights(this.highlights);
  }

  onChange(handler: () => void): void {
    this.changeHandler = handler;
  }

  displayOptions(): DisplayOption[] {
    const flowOption = (mode: EpubFlow, label: string, icon: string): DisplayOption => ({
      section: "layout",
      id: `flow-${mode}`,
      label,
      icon,
      checked: this.flowMode === mode,
      apply: () => {
        if (this.flowMode === mode) return;
        this.flowMode = mode;
        this.options.onPreferencesChanged({ textScale: this.textScale, flow: this.flowMode });
        // epub.js's own flow() re-displays at the current CFI, so the
        // reader keeps their place across the switch.
        this.rendition?.flow(epubFlow(mode));
        this.changeHandler?.();
      },
    });
    // "by chapter" is not decoration: one section renders at a time, so the
    // reader should not expect one continuous scroll through the whole book.
    return [
      flowOption("scrolled", "Scrolled (by chapter)", "move-vertical"),
      flowOption("paginated", "Paginated", "book-open"),
    ];
  }

  // ----------------------------------------------------------- navigation

  /**
   * Tap the left or right edge of a paginated page to turn it, and — because
   * `scrolled-doc` renders one section at a time — scroll past either end of
   * a chapter to reach the next or previous one.
   *
   * Both live inside the section's own document: neither a wheel nor a click
   * inside an iframe reaches the host, so like the context menu these attach
   * per section as it renders.
   */
  private addNavigationGestures(contents: EpubContents): void {
    const doc = contents.document;

    // A tap is only a tap if the pointer did not travel; otherwise it is the
    // tail of a drag-selection, whose `click` fires after highlight mode has
    // already consumed and cleared the selection — without this a highlight
    // would also turn the page.
    let downAt: { x: number; y: number } | null = null;
    doc.addEventListener("mousedown", (event: MouseEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
    });

    doc.addEventListener("click", (event: MouseEvent) => {
      const from = downAt;
      downAt = null;
      if (this.flowMode !== "paginated" || event.button !== 0) return;
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP_PX) return;
      // A link, or a live selection, means the tap was meant for the page.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("a[href]")) return;
      const selection = contents.window.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.getRangeAt(0).collapsed) return;

      const width = doc.documentElement.clientWidth;
      if (width <= 0) return;
      const fraction = event.clientX / width;
      if (fraction < TAP_ZONE) void this.turn("prev");
      else if (fraction > 1 - TAP_ZONE) void this.turn("next");
    });

    this.addScrollIntentListeners(doc);
  }

  /**
   * Watches for an attempt to scroll, on one document or element.
   *
   * This has to be attached in TWO places, and missing the second one is what
   * made a short chapter unscrollable. In `scrolled-doc` the section's iframe
   * is only as tall as its content, so a dedication page leaves most of the
   * pane covered by the host-side container instead. A wheel event goes to
   * whatever sits under the pointer and does not cross the iframe boundary in
   * either direction, so a listener inside the section's document alone sees
   * nothing at all once the pointer is past the last line of a short chapter.
   */
  private addScrollIntentListeners(target: Document | HTMLElement): void {
    target.addEventListener("wheel", ((event: WheelEvent) => this.noteScrollIntent(event.deltaY)) as EventListener, {
      passive: true,
    });

    // Touch produces no wheel events, so the same intent is measured from the
    // finger's own travel.
    let touchFrom: number | null = null;
    target.addEventListener(
      "touchstart",
      ((event: TouchEvent) => {
        touchFrom = event.touches[0]?.clientY ?? null;
      }) as EventListener,
      { passive: true },
    );
    target.addEventListener(
      "touchmove",
      ((event: TouchEvent) => {
        const y = event.touches[0]?.clientY;
        if (y === undefined || touchFrom === null) return;
        // Dragging the finger UP moves the page down, hence the inversion.
        this.noteScrollIntent(touchFrom - y);
        touchFrom = y;
      }) as EventListener,
      { passive: true },
    );
    target.addEventListener("touchend", (() => {
      touchFrom = null;
    }) as EventListener);
  }

  /**
   * Records an attempt to scroll by `delta` (positive is toward the end of the
   * book) and turns the chapter once enough of it has landed past the end.
   */
  private noteScrollIntent(delta: number): void {
    if (this.flowMode !== "scrolled" || delta === 0) return;
    this.startGestureIdleTimer();
    if (this.turnBlocked || this.turning) return;

    const stage = this.stageEl();
    if (!stage) return;
    const atBottom = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
    const atTop = stage.scrollTop <= 0;
    const pushingPastEnd = (delta > 0 && atBottom) || (delta < 0 && atTop);
    if (!pushingPastEnd) {
      this.overscroll = 0;
      return;
    }

    // Reversing direction starts the count again rather than cancelling out.
    if (this.overscroll !== 0 && Math.sign(this.overscroll) !== Math.sign(delta)) this.overscroll = 0;
    this.overscroll += delta;
    if (Math.abs(this.overscroll) < OVERSCROLL_THRESHOLD_PX) return;

    const direction = this.overscroll > 0 ? "next" : "prev";
    this.overscroll = 0;
    this.turnBlocked = true;
    void this.turn(direction);
  }

  /** Restarts the "scrolling has stopped" countdown; only that clears the block. */
  private startGestureIdleTimer(): void {
    const win = this.container?.win;
    if (!win) return;
    if (this.gestureIdleTimer !== null) win.clearTimeout(this.gestureIdleTimer);
    this.gestureIdleTimer = win.setTimeout(() => {
      this.gestureIdleTimer = null;
      this.overscroll = 0;
      this.turnBlocked = false;
    }, GESTURE_IDLE_MS);
  }

  /** epub.js's stage, which is what scrolls in `scrolled-doc`. */
  private stageEl(): HTMLElement | null {
    return this.container?.querySelector<HTMLElement>(".epub-container") ?? null;
  }

  /**
   * One chapter or page step. Guarded because both gestures can fire several
   * times while the next section is still loading.
   */
  private async turn(direction: "next" | "prev"): Promise<void> {
    const rendition = this.rendition;
    if (!rendition || this.turning) return;
    this.turning = true;
    try {
      await (direction === "next" ? rendition.next() : rendition.prev());
    } catch (error) {
      console.error("[e-reader] failed to turn the page", error);
    } finally {
      this.turning = false;
    }
  }

  // ---------------------------------------------------------------- theme

  /**
   * Each section renders inside an iframe that inherits none of Obsidian's
   * CSS, so without this a dark theme leaves dark text on a dark page and the
   * book is unreadable. Rather than epub.js's Themes — whose registerRules
   * only appends to an injected stylesheet and never replaces it, so it
   * cannot be refreshed — this owns one `<style>` element per section and
   * rewrites it in place.
   *
   * Colour is forced through the whole subtree because a book's own
   * stylesheet routinely sets one. Font family is set on `body` only, so a
   * book that has deliberately chosen a monospace face for its code keeps it.
   */
  private themeCss(): string {
    const host = this.container;
    if (!host) return "";
    const style = host.win.getComputedStyle(host);
    const read = (name: string, fallback: string): string => {
      const value = style.getPropertyValue(name).trim();
      return value === "" ? fallback : value;
    };
    const text = read("--text-normal", "#222");
    const background = read("--background-primary", "#fff");
    const accent = read("--text-accent", "#5b8def");
    const faint = read("--text-faint", "#999");
    const selection = read("--text-selection", "rgba(91, 141, 239, 0.25)");
    const font = read("--font-text", "inherit");
    const lineHeight = read("--line-height-normal", "1.5");
    return [
      `html, body { background: ${background} !important; color: ${text} !important; }`,
      `body { font-family: ${font}; line-height: ${lineHeight}; }`,
      `body *:not(img):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; }`,
      `a, a * { color: ${accent} !important; }`,
      `hr, table, td, th, blockquote { border-color: ${faint} !important; }`,
      `::selection { background: ${selection}; }`,
      // EPUBs routinely ship images sized for a page far wider than the
      // pane, which both overflows horizontally and — because the continuous
      // manager estimates a section's height before it renders — makes the
      // estimate wildly wrong once the image loads. Constraining them is a
      // correctness fix for the overflow and takes the worst of the churn out
      // of the height estimate.
      `img, svg, video { max-width: 100% !important; height: auto !important; }`,
      // Wide content is kept inside the page rather than widening it, which
      // is what lets the container suppress horizontal scrolling outright.
      `pre, code { white-space: pre-wrap !important; word-break: break-word; }`,
      `table { max-width: 100% !important; }`,
    ].join("\n");
  }

  private styleContents(contents: EpubContents): void {
    const doc = contents.document;
    const head = doc.head;
    if (!head) return;
    let styleEl = doc.getElementById(THEME_STYLE_ID);
    if (!styleEl) {
      styleEl = doc.createElement("style");
      styleEl.id = THEME_STYLE_ID;
      head.appendChild(styleEl);
    }
    styleEl.textContent = this.themeCss();
  }

  refreshTheme(): void {
    for (const contents of this.rendition?.getContents() ?? []) {
      this.styleContents(contents);
    }
  }

  // ----------------------------------------------------------- highlights

  async paintHighlights(highlights: readonly PaintedHighlight[]): Promise<void> {
    this.highlights = highlights;
    const annotations = this.rendition?.annotations;
    if (!annotations) return;
    for (const cfiRange of this.paintedRanges) annotations.remove(cfiRange, "highlight");
    this.paintedRanges.clear();
    for (const contents of this.rendition?.getContents() ?? []) {
      this.paintContents(contents);
    }
  }

  /** Draws whichever of the current highlights are found in this one section. */
  private paintContents(contents: EpubContents): void {
    const rendition = this.rendition;
    if (!rendition || this.highlights.length === 0) return;
    const body = contents.document.body;
    if (!body) return;

    const source = searchableText(body);
    if (source.index.text === "") return;

    for (const highlight of this.highlights) {
      const context: { prefix?: string; suffix?: string } = {};
      if (highlight.prefix !== undefined) context.prefix = highlight.prefix;
      if (highlight.suffix !== undefined) context.suffix = highlight.suffix;
      const range = rangeForQuote(source, highlight.exact, context);
      if (!range) continue;
      let cfiRange: string;
      try {
        cfiRange = contents.cfiFromRange(range);
      } catch (error) {
        console.debug("[e-reader] could not build a CFI for a saved highlight", highlight.id, error);
        continue;
      }
      // epub.js keys an annotation by cfiRange + type, so adding the same one
      // twice would attach two overlays to the same words.
      if (this.paintedRanges.has(cfiRange)) continue;
      this.paintedRanges.add(cfiRange);
      // The overlay lives inside the iframe, out of reach of styles.css, so
      // the colour has to be resolved here and passed as an attribute.
      rendition.annotations.highlight(cfiRange, { id: highlight.id }, undefined, "ereader-hl", {
        fill: highlightColor(this.container, highlight.type),
        "fill-opacity": "0.3",
        "mix-blend-mode": "multiply",
      });
    }
  }

  // ---------------------------------------------------------------- rest

  getSelection(): EngineSelection | null {
    const rendition = this.rendition;
    if (!rendition) return null;
    for (const contents of rendition.getContents()) {
      const range = activeRange(contents.window.getSelection());
      if (!range) continue;
      const snapshot = snapshotFromRange(contents.document.body, range);
      if (!snapshot) continue;
      let locator: Locator | null = null;
      try {
        locator = { kind: "epub", cfi: contents.cfiFromRange(range) };
      } catch (error) {
        // A range CFI is a convenience, not a requirement — the quoted text
        // is what re-anchors the entry.
        console.debug("[e-reader] could not build a CFI for the selection", error);
      }
      return { ...snapshot, locator };
    }
    return null;
  }

  onContextMenu(handler: (position: { x: number; y: number }) => void): void {
    this.contextMenuHandler = handler;
  }


  async outline(): Promise<OutlineNode[]> {
    const book = this.book;
    if (!book) return [];
    return outlineFromToc(book, book.navigation.toc);
  }

  async search(query: string): Promise<SearchHit[]> {
    const book = this.book;
    const trimmed = query.trim();
    if (!book || trimmed === "") return [];
    const hits: SearchHit[] = [];
    for (const section of book.spine.spineItems) {
      try {
        await section.load((url) => book.load(url));
        for (const match of section.find(trimmed)) {
          hits.push({ excerpt: match.excerpt, locator: { kind: "epub", cfi: match.cfi } });
        }
      } catch (error) {
        console.error("[e-reader] failed to search an epub section", error);
      } finally {
        section.unload();
      }
    }
    return hits;
  }

  destroy(): void {
    this.contextMenuHandler = null;
    this.changeHandler = null;
    this.turning = false;
    this.turnBlocked = false;
    this.overscroll = 0;
    if (this.gestureIdleTimer !== null) {
      this.container?.win.clearTimeout(this.gestureIdleTimer);
      this.gestureIdleTimer = null;
    }
    this.paintedRanges.clear();
    this.highlights = [];
    this.rendition?.destroy();
    this.rendition = null;
    this.book?.destroy();
    this.book = null;
    this.container = null;
    this.lastCfi = null;
  }
}

export function createEpubEngine(app: App, options: EpubEngineOptions): ReaderEngine {
  return new EpubEngine(app, options);
}
