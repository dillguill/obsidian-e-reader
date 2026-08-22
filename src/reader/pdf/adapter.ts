// PDF adapter: pdfjs-dist, bundled straight into main.js (see
// esbuild.config.mjs — no vendor dir, no vault.adapter.getResourcePath()
// resource-path resolution) and imported dynamically so that none of it is
// evaluated until a PDF is actually opened.
//
// The dynamic import is what Principle V requires, and it is safe here in a
// way an earlier attempt was not: with `format: "cjs"` and `splitting: false`,
// esbuild keeps the imported module inside main.js and merely defers its
// evaluation. Nothing is fetched at runtime. The failure that made this look
// impossible before — "Failed to fetch dynamically imported module:
// app://obsidian.md/vendor/pdfjs/pdf.min.mjs" — came from importing an
// unbundled file by relative path, which resolved against the app origin.
//
// pdf.js needs its worker script served from a URL it can spin up a Worker
// from; there is no vendor/ directory to point at anymore, so the worker's
// minified source is inlined into main.js as a text asset (an esbuild plugin
// in esbuild.config.mjs loads pdfjs-dist/build/pdf.worker.min.mjs as a
// string) and turned into a same-origin blob: URL at runtime instead.
//
// No pdfjs type may leak past this module — callers only see
// ReaderEngine/OutlineNode/FindState/... (../engine.ts).

import type { App } from "obsidian";
import type { Locator } from "../../core/types";
import { normalizeQuote } from "../../annotations/anchor";
import { activeRange, rangeForQuote, rangeFromOffsets, searchableText, snapshotFromRange } from "../dom-selection";
import type {
  DisplayOption,
  EngineSelection,
  FindQuery,
  FindState,
  OutlineNode,
  PageState,
  PaintedHighlight,
  ReaderEngine,
} from "../engine";
import {
  type MatchAt,
  countMatches,
  firstMatch,
  matchIndex,
  matchOffsets,
  stepMatch,
  totalMatches,
} from "../find-text";
import { buildTextIndex } from "../text-index";
import { pdfPageToPercent } from "../progress";
import { type Point, isPinchWorthApplying, pinchDistance, pinchScale } from "../pinch";
import { type SpreadMode, spreadRows } from "../spread";
import type { PdfFit } from "../../settings/settings-model";
import { clampScale, fitRowSize, fitScale } from "../zoom";

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsTextItem {
  str: string;
}

interface PdfjsTextContent {
  items: PdfjsTextItem[];
}

interface PdfjsRenderTask {
  promise: Promise<void>;
}

interface PdfjsPage {
  getViewport(opts: { scale: number }): PdfjsViewport;
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfjsViewport }): PdfjsRenderTask;
  getTextContent(): Promise<PdfjsTextContent>;
  streamTextContent(): unknown;
}

interface PdfjsOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: PdfjsOutlineItem[];
}

interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
  getOutline(): Promise<PdfjsOutlineItem[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

/**
 * What `getDocument` returns. `destroy` lives HERE, on the loading task, and
 * not on the document proxy it resolves to — the proxy only offers
 * `cleanup()`. Without it the worker a book started outlives the book.
 */
interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
  destroy(): Promise<void>;
}

interface PdfjsTextLayer {
  render(): Promise<void>;
}

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(opts: { data: ArrayBuffer }): PdfjsLoadingTask;
  TextLayer: new (opts: {
    textContentSource: unknown;
    container: HTMLElement;
    viewport: PdfjsViewport;
  }) => PdfjsTextLayer;
}

/** Preferences this engine owns, handed in at construction and reported back on change. */
export interface PdfPreferences {
  scale: number;
  fit: PdfFit;
  spread: SpreadMode;
  adaptToTheme: boolean;
}

export interface PdfEngineOptions extends PdfPreferences {
  /** Called whenever a toolbar action changes one of the above, so it can be persisted. */
  onPreferencesChanged(preferences: PdfPreferences): void;
}

/**
 * Loads pdf.js and its worker source on first use. The promise is cached so a
 * second book pays nothing, and so two concurrent opens share one evaluation.
 */
let pdfjsPromise: Promise<{ lib: PdfjsModule; workerSource: string }> | null = null;

function loadPdfjs(): Promise<{ lib: PdfjsModule; workerSource: string }> {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist") as Promise<unknown>,
      import("pdfjs-dist/build/pdf.worker.min.mjs"),
    ]);
    return { lib: lib as PdfjsModule, workerSource: worker.default };
  })();
  return pdfjsPromise;
}

async function resolveDestPage(doc: PdfjsDocument, item: PdfjsOutlineItem): Promise<number | null> {
  try {
    const explicitDest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
    const ref = explicitDest?.[0];
    if (ref === undefined || ref === null) return null;
    const index = await doc.getPageIndex(ref);
    return index + 1;
  } catch {
    return null;
  }
}

async function outlineFromPdf(doc: PdfjsDocument, items: PdfjsOutlineItem[]): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = [];
  for (const item of items) {
    const page = await resolveDestPage(doc, item);
    const children = item.items.length > 0 ? await outlineFromPdf(doc, item.items) : [];
    if (page === null && children.length === 0) continue;
    nodes.push({
      label: item.title,
      locator: { kind: "pdf", page: page ?? 1 },
      children,
    });
  }
  return nodes;
}

export class PdfEngine implements ReaderEngine {
  private doc: PdfjsDocument | null = null;
  private loadingTask: PdfjsLoadingTask | null = null;
  private container: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  /** Indexed by page number - 1, whichever row element each one currently sits in. */
  private pageEls: HTMLElement[] = [];
  private observer: IntersectionObserver | null = null;
  private currentPage = 1;
  /**
   * Every page the observer currently reports as intersecting. The page the
   * reader is ON is the topmost of them, and only tracking the set makes that
   * knowable: the observer reports entries in no particular order, and with a
   * 200px margin several pages intersect at once.
   */
  private visiblePages = new Set<number>();
  private workerBlobUrl: string | null = null;
  private pdfjs: PdfjsModule | null = null;
  private contextMenuHandler: ((position: { x: number; y: number }) => boolean) | null = null;
  private selectionEndHandler: (() => void) | null = null;
  private changeHandler: (() => void) | null = null;
  /** A page's size at scale 1, for the fit-to-width/height calculations. */
  private baseSize: { width: number; height: number } = { width: 0, height: 0 };
  private renderScale: number;
  private fit: PdfFit;
  private spread: SpreadMode;
  /** Watches the pane so a fit survives a resize or a device rotation. */
  private resizeObserver: ResizeObserver | null = null;
  private themed: boolean;
  private highlights: readonly PaintedHighlight[] = [];
  /**
   * Owns every listener this engine attaches. Aborting it in `destroy()` is
   * what makes the clean-unload guarantee (Principle II) structural rather
   * than a bet on the caller removing the elements we attached to.
   */
  private listeners: AbortController | null = null;

  constructor(
    private readonly app: App,
    private readonly options: PdfEngineOptions,
  ) {
    this.renderScale = clampScale(options.scale);
    this.fit = options.fit;
    this.spread = options.spread;
    this.themed = options.adaptToTheme;
  }

  async open(path: string, container: HTMLElement): Promise<void> {
    this.destroy();
    this.listeners = new AbortController();

    const { lib: pdfjsModule, workerSource } = await loadPdfjs();
    this.pdfjs = pdfjsModule;
    const blob = new Blob([workerSource], { type: "text/javascript" });
    this.workerBlobUrl = URL.createObjectURL(blob);
    pdfjsModule.GlobalWorkerOptions.workerSrc = this.workerBlobUrl;

    const data = await this.app.vault.adapter.readBinary(path);
    const loadingTask = pdfjsModule.getDocument({ data });
    this.loadingTask = loadingTask;
    this.doc = await loadingTask.promise;

    this.container = container;
    this.scrollEl = container.createDiv({ cls: "ereader-reader__pdf-scroll" });
    this.scrollEl.toggleClass("is-themed", this.themed);

    const first = await this.doc.getPage(1);
    const unscaled = first.getViewport({ scale: 1 });
    this.baseSize = { width: unscaled.width, height: unscaled.height };

    this.applyFit();
    await this.layout();
    this.watchForResize();
    this.addPinchListeners();
  }

  // ------------------------------------------------------------- layout

  /**
   * Builds one element per spread row, each holding one or two page
   * placeholders sized from the current scale, and starts watching them.
   * Canvases are only rendered as pages come into view — rendering every page
   * of a large book up front would freeze the app.
   */
  private async layout(): Promise<void> {
    const doc = this.doc;
    const scrollEl = this.scrollEl;
    if (!doc || !scrollEl) return;

    this.observer?.disconnect();
    this.visiblePages.clear();
    scrollEl.empty();
    this.pageEls = [];

    for (const row of spreadRows(doc.numPages, this.spread)) {
      const rowEl = scrollEl.createDiv({ cls: "ereader-reader__pdf-row" });
      for (const pageNumber of row) {
        const pageEl = rowEl.createDiv({ cls: "ereader-reader__pdf-page" });
        pageEl.dataset["page"] = String(pageNumber);
        // Every placeholder is sized from page 1's viewport. A document whose
        // pages differ in size scrolls slightly off until each real page
        // renders and corrects its own box — the alternative is awaiting a
        // getPage() for every page of the book before showing anything.
        pageEl.style.width = `${this.baseSize.width * this.renderScale}px`;
        pageEl.style.height = `${this.baseSize.height * this.renderScale}px`;
        this.pageEls[pageNumber - 1] = pageEl;
      }
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset["page"]);
          if (!pageNumber) continue;
          if (entry.isIntersecting) {
            this.visiblePages.add(pageNumber);
            void this.renderPageInto(pageNumber);
          } else {
            this.visiblePages.delete(pageNumber);
          }
        }
        // Taking the last entry the observer happened to report put the
        // reader on an arbitrary one of the pages in view — which zooming
        // then used as the anchor to restore, landing somewhere else
        // entirely. The topmost page in view is the one being read.
        if (this.visiblePages.size === 0) return;
        const top = Math.min(...this.visiblePages);
        if (top === this.currentPage) return;
        this.currentPage = top;
        this.changeHandler?.();
      },
      { root: scrollEl, rootMargin: "200px 0px" },
    );
    for (const el of this.pageEls) this.observer.observe(el);
  }

  /**
   * Rebuilds the layout at the current scale and spread, then returns to
   * `anchorPage`. Everything rendered is discarded: a canvas is rasterised at
   * one scale and cannot be re-used at another.
   */
  /**
   * Recomputes the scale from the pane when a fit is in force. Returns whether
   * it actually changed, so a resize that does not move it costs nothing.
   */
  private applyFit(): boolean {
    if (this.fit === "none") return false;
    const row = fitRowSize(this.baseSize, this.spread === "single" ? 1 : 2, this.rowGap());
    const next = fitScale(this.availableSize(), row, this.fit);
    if (Math.abs(next - this.renderScale) < 0.005) return false;
    this.renderScale = next;
    return true;
  }

  /**
   * A fit is a promise about the pane, not a number, so it has to be honoured
   * again whenever the pane changes — a split being dragged, a sidebar
   * opening, a phone being turned. Without this a fitted page simply
   * overflows the moment anything moves.
   */
  private watchForResize(): void {
    const scrollEl = this.scrollEl;
    if (!scrollEl || typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => {
      if (!this.applyFit()) return;
      this.savePreferences();
      void this.relayout(this.currentPage);
    });
    this.resizeObserver.observe(scrollEl);
  }

  private async relayout(anchorPage: number): Promise<void> {
    await this.layout();
    await this.goTo({ kind: "pdf", page: anchorPage });
    this.changeHandler?.();
  }

  private async renderPageInto(pageNumber: number): Promise<void> {
    const doc = this.doc;
    const pageEl = this.pageEls[pageNumber - 1];
    if (!doc || !pageEl || pageEl.dataset["rendered"] === "1") return;
    pageEl.dataset["rendered"] = "1";

    const page = await doc.getPage(pageNumber);
    // Two viewports, and the difference is what keeps text sharp. `viewport`
    // is the CSS-pixel geometry: it sizes the page box and positions the text
    // layer. `renderViewport` is that multiplied by the display's device
    // pixel ratio, and is what the canvas is actually rasterised at. Sizing
    // the bitmap in CSS pixels — as this did — hands a 1x image to a 2x
    // display, which the browser then upscales, and every glyph comes out
    // soft.
    const viewport = page.getViewport({ scale: this.renderScale });
    const ratio = pageEl.win.devicePixelRatio || 1;
    const renderViewport = page.getViewport({ scale: this.renderScale * ratio });

    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;

    const canvas = pageEl.createEl("canvas", { cls: "ereader-reader__pdf-canvas" });
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    // The canvas fills the page box through CSS (styles.css), so the larger
    // bitmap is displayed at the CSS size rather than overflowing it.
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

    // Saved highlights and find marks are drawn beneath the text layer so
    // that selecting text still works over them. They get a layer each so
    // that repainting one does not wipe the other.
    pageEl.createDiv({ cls: "ereader-reader__pdf-highlights" });
    pageEl.createDiv({ cls: "ereader-reader__pdf-find" });

    // The text layer is what makes a PDF selectable — without it the page is
    // just pixels, and there is nothing to highlight. pdf.js positions its
    // spans from `--scale-factor`, so the container must carry the same scale
    // the canvas was rendered at.
    const textLayerEl = pageEl.createDiv({ cls: "ereader-reader__pdf-text" });
    textLayerEl.setCssProps({ "--scale-factor": String(this.renderScale), "--user-unit": "1" });
    try {
      const textLayer = new (this.pdfjs as PdfjsModule).TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayerEl,
        viewport,
      });
      await textLayer.render();
    } catch (error) {
      console.error("[e-reader] failed to render a PDF text layer", pageNumber, error);
    }

    // A page that arrives after the highlights or a search did still gets them.
    this.paintPage(pageNumber);
    this.paintFindPage(pageNumber);
  }

  async goTo(locator: Locator): Promise<void> {
    if (locator.kind !== "pdf" || !this.doc) return;
    const page = Math.min(Math.max(1, Math.round(locator.page)), this.doc.numPages);
    this.currentPage = page;
    await this.renderPageInto(page);
    this.pageEls[page - 1]?.scrollIntoView({ block: "start" });
    // The observer reports the pages around the new position a moment later
    // and would otherwise re-derive `currentPage` from a stale set.
    this.visiblePages.clear();
    this.visiblePages.add(page);
  }

  currentLocator(): Locator | null {
    if (!this.doc) return null;
    return { kind: "pdf", page: this.currentPage };
  }

  progress(): number {
    if (!this.doc) return 0;
    return pdfPageToPercent(this.currentPage, this.doc.numPages);
  }

  // ------------------------------------------------------------ toolbar

  pageState(): PageState | null {
    if (!this.doc) return null;
    return { current: this.currentPage, total: this.doc.numPages, unit: "page" };
  }

  async goToPage(page: number): Promise<void> {
    await this.goTo({ kind: "pdf", page });
  }

  pageNumberFor(locator: Locator): number | null {
    return locator.kind === "pdf" ? locator.page : null;
  }

  scale(): number {
    return this.renderScale;
  }

  async setScale(scale: number): Promise<void> {
    const next = clampScale(scale);
    // Zooming by hand is what releases the fit — otherwise the next resize
    // would silently undo the reader's choice.
    const releasingFit = this.fit !== "none";
    if (next === this.renderScale && !releasingFit) return;
    this.fit = "none";
    this.renderScale = next;
    this.savePreferences();
    await this.relayout(this.currentPage);
  }

  /** Switches to a fit, or back to a plain scale, and re-renders. */
  private async setFit(fit: PdfFit, scale?: number): Promise<void> {
    this.fit = fit;
    if (scale !== undefined) this.renderScale = clampScale(scale);
    this.applyFit();
    this.savePreferences();
    await this.relayout(this.currentPage);
  }

  onChange(handler: () => void): void {
    this.changeHandler = handler;
  }

  displayOptions(): DisplayOption[] {
    const at = (value: number): boolean => this.fit === "none" && Math.abs(this.renderScale - value) < 0.01;

    const spreadOption = (mode: SpreadMode, label: string, icon: string): DisplayOption => ({
      section: "spread",
      id: `spread-${mode}`,
      label,
      icon,
      checked: this.spread === mode,
      apply: async () => {
        if (this.spread === mode) return;
        this.spread = mode;
        // A spread changes how wide a row is, so a fit has to be recomputed.
        this.applyFit();
        this.savePreferences();
        await this.relayout(this.currentPage);
      },
    });

    return [
      {
        section: "zoom",
        id: "fit-width",
        label: "Fit width",
        icon: "move-horizontal",
        checked: this.fit === "width",
        apply: () => this.setFit("width"),
      },
      {
        section: "zoom",
        id: "fit-height",
        label: "Fit height",
        icon: "move-vertical",
        checked: this.fit === "height",
        apply: () => this.setFit("height"),
      },
      {
        section: "zoom",
        id: "actual-size",
        label: "Actual size",
        icon: "scan",
        checked: at(1),
        apply: () => this.setFit("none", 1),
      },
      spreadOption("single", "Single page", "rectangle-vertical"),
      spreadOption("odd", "Two pages (odd)", "columns-2"),
      spreadOption("even", "Two pages (even)", "columns-2"),
      {
        section: "appearance",
        id: "adapt-to-theme",
        label: "Adapt to theme",
        icon: "palette",
        checked: this.themed,
        apply: () => {
          this.themed = !this.themed;
          this.scrollEl?.toggleClass("is-themed", this.themed);
          this.savePreferences();
          this.changeHandler?.();
        },
      },
    ];
  }

  /**
   * The space a row actually has to fit into: the scroll box's padding box
   * (clientWidth/Height already exclude any scrollbar) less its own padding.
   * Measured rather than hardcoded — a constant duplicating the stylesheet
   * would silently mis-fit the moment the padding changed.
   */
  private availableSize(): { width: number; height: number } {
    const scrollEl = this.scrollEl;
    if (!scrollEl) return { width: 0, height: 0 };
    const style = scrollEl.win.getComputedStyle(scrollEl);
    const px = (value: string): number => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    // A pixel of slack, because pdf.js rounds a viewport's width UP: a page
    // rendered at exactly the fitted scale can come back a fraction wider
    // than the space measured for it, and a fraction is enough to raise a
    // scrollbar.
    return {
      width: scrollEl.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - 1,
      height: scrollEl.clientHeight - px(style.paddingTop) - px(style.paddingBottom) - 1,
    };
  }

  /** The gap between two pages of a spread, from the stylesheet. */
  private rowGap(): number {
    const rowEl = this.scrollEl?.querySelector<HTMLElement>(".ereader-reader__pdf-row");
    if (!rowEl) return 0;
    const parsed = Number.parseFloat(rowEl.win.getComputedStyle(rowEl).columnGap);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private savePreferences(): void {
    this.options.onPreferencesChanged({
      scale: this.renderScale,
      fit: this.fit,
      spread: this.spread,
      adaptToTheme: this.themed,
    });
  }

  // --------------------------------------------------------- highlights

  async paintHighlights(highlights: readonly PaintedHighlight[]): Promise<void> {
    this.highlights = highlights;
    for (let pageNumber = 1; pageNumber <= this.pageEls.length; pageNumber++) {
      this.paintPage(pageNumber);
    }
  }

  /**
   * Draws every highlight that belongs on this page as boxes over its text
   * layer. A highlight carrying a hint is only tried against its own page;
   * one without a hint is tried against every rendered page, since there is
   * nothing else to narrow it down by.
   */
  private paintPage(pageNumber: number): void {
    const pageEl = this.pageEls[pageNumber - 1];
    const layerEl = pageEl?.querySelector<HTMLElement>(".ereader-reader__pdf-highlights");
    const textEl = pageEl?.querySelector<HTMLElement>(".ereader-reader__pdf-text");
    if (!pageEl || !layerEl || !textEl) return;

    layerEl.empty();
    const wanted = this.highlights.filter((highlight) => {
      const hint = highlight.hint;
      return hint === undefined || hint.kind !== "pdf" || hint.page === pageNumber;
    });
    if (wanted.length === 0) return;

    const source = searchableText(textEl);
    if (source.index.text === "") return;
    const pageRect = pageEl.getBoundingClientRect();

    for (const highlight of wanted) {
      const context: { prefix?: string; suffix?: string } = {};
      if (highlight.prefix !== undefined) context.prefix = highlight.prefix;
      if (highlight.suffix !== undefined) context.suffix = highlight.suffix;
      const range = rangeForQuote(source, highlight.exact, context);
      if (!range) continue;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const box = layerEl.createDiv({ cls: "ereader-hl" });
        // The reader hit-tests these by rect on right-click, so each box has
        // to say which entry it belongs to. epub.js's overlay does the same
        // through marks-pane, which writes the annotation's `data` out as
        // dataset entries — hence `data-id` on both sides.
        box.dataset["id"] = highlight.id;
        box.dataset["type"] = highlight.type;
        // The visible page is the canvas UNDER this layer, so the box has to
        // blend rather than cover; styles.css sets the blend mode.
        box.style.background = highlight.color;
        box.style.left = `${rect.left - pageRect.left}px`;
        box.style.top = `${rect.top - pageRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      }
    }
  }

  refreshTheme(): void {
    // A PDF renders in the host document, so it already follows the vault's
    // theme; the only theme-derived thing here is the invert filter, which is
    // pure CSS keyed off `.theme-dark`.
  }

  // --------------------------------------------------------------- rest

  getSelection(): EngineSelection | null {
    const scrollEl = this.scrollEl;
    if (!scrollEl) return null;
    const range = activeRange(scrollEl.win.getSelection());
    if (!range || !scrollEl.contains(range.commonAncestorContainer)) return null;

    // Anchor context comes from the page the selection starts on: page
    // boundaries are not sentence boundaries, so walking past one would pull
    // in text that does not surround the quote on the page.
    const pageEl = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest(
      ".ereader-reader__pdf-page",
    );
    const snapshot = snapshotFromRange((pageEl as HTMLElement | null) ?? scrollEl, range);
    if (!snapshot) return null;
    const page = Number((pageEl as HTMLElement | null)?.dataset["page"] ?? this.currentPage);
    return { ...snapshot, locator: { kind: "pdf", page: Number.isFinite(page) && page > 0 ? page : this.currentPage } };
  }

  onContextMenu(handler: (position: { x: number; y: number }) => boolean): void {
    this.contextMenuHandler = handler;
    const scrollEl = this.scrollEl;
    if (!scrollEl) return;
    scrollEl.addEventListener(
      "contextmenu",
      (event: MouseEvent) => {
        const current = this.contextMenuHandler;
        if (!current) return;
        // Whether to suppress the default is the handler's call, not this
        // adapter's. A long press on a touchscreen fires `contextmenu` AND
        // starts the platform's own text selection, so preventing one that
        // was meant to select destroys the selection being made — the
        // handler only claims a press it can actually act on.
        if (current({ x: event.clientX, y: event.clientY })) event.preventDefault();
      },
      { signal: this.listeners?.signal },
    );
  }

  clearSelection(): void {
    this.scrollEl?.win.getSelection()?.removeAllRanges();
  }

  /**
   * Pinch to zoom, applied when the fingers lift.
   *
   * Not passive: the browser's own pinch-zoom has to be refused, or the whole
   * app is scaled instead of the page. And not continuous: the canvas is
   * rasterised at one scale, and live-scaling a transform would slide the
   * text layer off the glyphs it covers, which is what selection depends on.
   */
  private addPinchListeners(): void {
    const scrollEl = this.scrollEl;
    if (!scrollEl) return;
    const options = { passive: false, signal: this.listeners?.signal };
    let startDistance = 0;
    let startScale = 1;
    let current = 1;

    const points = (event: TouchEvent): [Point, Point] | null => {
      const [a, b] = [event.touches[0], event.touches[1]];
      if (!a || !b) return null;
      return [
        { x: a.clientX, y: a.clientY },
        { x: b.clientX, y: b.clientY },
      ];
    };

    scrollEl.addEventListener(
      "touchstart",
      (event: TouchEvent) => {
        const pair = points(event);
        if (!pair) return;
        startDistance = pinchDistance(pair[0], pair[1]);
        startScale = this.renderScale;
        current = startScale;
      },
      options,
    );

    scrollEl.addEventListener(
      "touchmove",
      (event: TouchEvent) => {
        const pair = points(event);
        if (!pair || startDistance === 0) return;
        event.preventDefault();
        current = pinchScale(startScale, startDistance, pinchDistance(pair[0], pair[1]));
      },
      options,
    );

    const finish = (): void => {
      if (startDistance === 0) return;
      startDistance = 0;
      if (!isPinchWorthApplying(startScale, current)) return;
      void this.setScale(current);
    };
    scrollEl.addEventListener("touchend", finish, options);
    scrollEl.addEventListener("touchcancel", finish, options);
  }

  onSelectionEnd(handler: () => void): void {
    this.selectionEndHandler = handler;
    const scrollEl = this.scrollEl;
    if (!scrollEl) return;
    // The text layer is a child of the scroll box, so a release anywhere in
    // the document bubbles to here.
    const fire = (): void => this.selectionEndHandler?.();
    const options = { signal: this.listeners?.signal };
    scrollEl.addEventListener("mouseup", fire, options);
    scrollEl.addEventListener("touchend", fire, options);
  }

  async outline(): Promise<OutlineNode[]> {
    if (!this.doc) return [];
    const items = await this.doc.getOutline();
    if (!items) return [];
    return outlineFromPdf(this.doc, items);
  }

  // --------------------------------------------------------------- find
  //
  // pdf.js ships a PDFFindController, but it is built around PDFViewer: it
  // reports its matches as offsets into its own page-content string and
  // leaves the drawing to TextHighlighter, which pdf_viewer.mjs does not
  // export. Using it would mean hand-writing the harder half — mapping those
  // offsets onto this adapter's text layers — so the search is done here
  // instead, over the primitives the highlight painting already uses
  // (buildTextIndex / rangeFromOffsets) and the stepping arithmetic in
  // ../find-text.ts, all of them unit-tested.

  /**
   * How many matches each page holds, indexed by page number - 1, filled in
   * as the scan reaches each page. Only the counts are kept: the offsets are
   * found again against the rendered text layer when a page is painted, so a
   * difference between the text pdf.js streams and the spans it builds from
   * it cannot put a mark in the wrong place.
   */
  private findCounts: number[] = [];
  private findQuery: FindQuery | null = null;
  /** The match the find bar is on, or null for none. */
  private findAt: MatchAt | null = null;
  /** Guards against a slow scan reporting over a newer one. */
  private findToken = 0;
  private findPending = false;
  private findStateHandler: ((state: FindState) => void) | null = null;
  /** Normalised page text, keyed by page number. Cleared with the document. */
  private readonly pageTexts = new Map<number, string>();

  find(query: FindQuery): void {
    const token = ++this.findToken;
    const doc = this.doc;
    this.findQuery = query;
    this.findAt = null;
    // Sized up front so that a page the scan has not reached reads as zero
    // matches rather than as a shorter book.
    this.findCounts = doc ? new Array<number>(doc.numPages).fill(0) : [];
    this.findPending = false;

    if (!doc || normalizeQuote(query.query) === "") {
      this.findQuery = null;
      this.repaintFind();
      this.reportFindState();
      return;
    }
    this.findPending = true;
    this.reportFindState();
    this.repaintFind();
    void this.scanForMatches(token);
  }

  findNext(backwards: boolean): void {
    const at = this.findAt;
    const next = at
      ? stepMatch(this.findCounts, at, backwards)
      : firstMatch(this.findCounts, this.currentPage);
    if (next) void this.goToMatch(next);
  }

  findClose(): void {
    this.findToken++;
    this.findQuery = null;
    this.findCounts = [];
    this.findAt = null;
    this.findPending = false;
    this.repaintFind();
    this.reportFindState();
  }

  onFindState(handler: (state: FindState) => void): void {
    this.findStateHandler = handler;
  }

  private reportFindState(): void {
    const total = totalMatches(this.findCounts);
    const at = this.findAt;
    this.findStateHandler?.({
      current: at ? matchIndex(this.findCounts, at) + 1 : 0,
      total,
      pending: this.findPending,
      notFound: !this.findPending && this.findQuery !== null && total === 0,
    });
  }

  /**
   * Counts the matches on every page, starting at the one being read so that
   * the first result is the nearest one rather than the first in the book,
   * and jumping to it as soon as it is known. A long PDF takes a while — each
   * page's text comes from the worker — so the state is reported as the scan
   * goes and the find bar shows its progress.
   */
  private async scanForMatches(token: number): Promise<void> {
    const doc = this.doc;
    const query = this.findQuery;
    if (!doc || !query) return;

    const pages = doc.numPages;
    const from = Math.min(Math.max(1, this.currentPage), pages);

    for (let step = 0; step < pages; step++) {
      const pageNumber = ((from - 1 + step) % pages) + 1;
      let text: string;
      try {
        text = await this.pageText(pageNumber);
      } catch (error) {
        console.error("[e-reader] failed to read a PDF page's text", pageNumber, error);
        text = "";
      }
      if (token !== this.findToken) return; // a newer search replaced this one

      this.findCounts[pageNumber - 1] = countMatches(text, query);
      // The first page found to hold a match is the nearest one, because the
      // scan walks outward from the page being read.
      if (!this.findAt && (this.findCounts[pageNumber - 1] ?? 0) > 0) {
        void this.goToMatch({ page: pageNumber, nth: 0 });
      } else {
        this.reportFindState();
        this.paintFindPage(pageNumber);
      }
    }

    if (token !== this.findToken) return;
    this.findPending = false;
    this.reportFindState();
  }

  /** A page's normalised text, read from the worker once and kept. */
  private async pageText(pageNumber: number): Promise<string> {
    const cached = this.pageTexts.get(pageNumber);
    if (cached !== undefined) return cached;
    const doc = this.doc;
    if (!doc) return "";
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    // Built exactly as the rendered text layer's index is: one chunk per text
    // item, whitespace collapsed across the joins (src/reader/text-index.ts).
    const text = buildTextIndex(content.items.map((item) => ({ text: item.str }))).text;
    this.pageTexts.set(pageNumber, text);
    return text;
  }

  private async goToMatch(at: MatchAt): Promise<void> {
    const previous = this.findAt;
    this.findAt = at;
    this.reportFindState();
    if (at.page !== this.currentPage) await this.goTo({ kind: "pdf", page: at.page });
    // Only the two pages whose marks changed need redrawing.
    if (previous && previous.page !== at.page) this.paintFindPage(previous.page);
    this.paintFindPage(at.page);
    this.pageEls[at.page - 1]
      ?.querySelector(".ereader-hl-find--current")
      ?.scrollIntoView({ block: "center" });
  }

  private repaintFind(): void {
    for (let pageNumber = 1; pageNumber <= this.pageEls.length; pageNumber++) {
      this.paintFindPage(pageNumber);
    }
  }

  /**
   * Draws this page's matches over its text layer, the current one apart from
   * the rest. The offsets are found again here, against the spans that were
   * actually rendered, rather than carried over from the scan.
   */
  private paintFindPage(pageNumber: number): void {
    const pageEl = this.pageEls[pageNumber - 1];
    const layerEl = pageEl?.querySelector<HTMLElement>(".ereader-reader__pdf-find");
    const textEl = pageEl?.querySelector<HTMLElement>(".ereader-reader__pdf-text");
    if (!pageEl || !layerEl || !textEl) return;

    layerEl.empty();
    const query = this.findQuery;
    if (!query) return;

    const source = searchableText(textEl);
    const offsets = matchOffsets(source.index.text, query);
    if (offsets.length === 0) return;

    const at = this.findAt;
    const currentNth = at && at.page === pageNumber ? at.nth : -1;
    const pageRect = pageEl.getBoundingClientRect();
    const needle = normalizeQuote(query.query);

    offsets.forEach((offset, nth) => {
      // Without "highlight all" only the match being visited is drawn.
      if (!query.highlightAll && nth !== currentNth) return;
      const range = rangeFromOffsets(source, offset, offset + needle.length);
      if (!range) return;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const box = layerEl.createDiv({ cls: "ereader-hl-find" });
        box.toggleClass("ereader-hl-find--current", nth === currentNth);
        box.style.left = `${rect.left - pageRect.left}px`;
        box.style.top = `${rect.top - pageRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      }
    });
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.listeners?.abort();
    this.listeners = null;
    this.contextMenuHandler = null;
    this.selectionEndHandler = null;
    this.changeHandler = null;
    this.observer?.disconnect();
    this.observer = null;
    this.visiblePages.clear();
    this.pageEls = [];
    this.scrollEl = null;
    // Tearing down must never throw: `open()` calls this first, so a failure
    // here would stop the NEXT book from opening at all.
    try {
      void this.loadingTask?.destroy();
    } catch (error) {
      console.error("[e-reader] failed to release a PDF", error);
    }
    this.loadingTask = null;
    this.doc = null;
    this.pdfjs = null;
    this.container = null;
    this.highlights = [];
    this.findToken++;
    this.findQuery = null;
    this.findCounts = [];
    this.findAt = null;
    this.findPending = false;
    this.findStateHandler = null;
    this.pageTexts.clear();
    if (this.workerBlobUrl !== null) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }
}

export function createPdfEngine(app: App, options: PdfEngineOptions): ReaderEngine {
  return new PdfEngine(app, options);
}
