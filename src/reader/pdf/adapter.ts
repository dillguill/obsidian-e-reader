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
// ReaderEngine/OutlineNode/SearchHit/... (../engine.ts).

import type { App } from "obsidian";
import type { Locator } from "../../core/types";
import { activeRange, rangeForQuote, searchableText, snapshotFromRange } from "../dom-selection";
import type { DisplayOption, EngineSelection, OutlineNode, PageState, PaintedHighlight, ReaderEngine, SearchHit } from "../engine";
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

interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
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
  private container: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  /** Indexed by page number - 1, whichever row element each one currently sits in. */
  private pageEls: HTMLElement[] = [];
  private observer: IntersectionObserver | null = null;
  private currentPage = 1;
  private workerBlobUrl: string | null = null;
  private pdfjs: PdfjsModule | null = null;
  private contextMenuHandler: ((position: { x: number; y: number }) => void) | null = null;
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
            void this.renderPageInto(pageNumber);
            this.currentPage = pageNumber;
            this.changeHandler?.();
          }
        }
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

    // Saved highlights are drawn beneath the text layer so that selecting
    // text still works over them.
    pageEl.createDiv({ cls: "ereader-reader__pdf-highlights" });

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

    // A page that arrives after the highlights did still gets them.
    this.paintPage(pageNumber);
  }

  async goTo(locator: Locator): Promise<void> {
    if (locator.kind !== "pdf" || !this.doc) return;
    const page = Math.min(Math.max(1, Math.round(locator.page)), this.doc.numPages);
    this.currentPage = page;
    await this.renderPageInto(page);
    this.pageEls[page - 1]?.scrollIntoView({ block: "start" });
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
    return {
      width: scrollEl.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
      height: scrollEl.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
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

  onContextMenu(handler: (position: { x: number; y: number }) => void): void {
    this.contextMenuHandler = handler;
    const scrollEl = this.scrollEl;
    if (!scrollEl) return;
    scrollEl.addEventListener(
      "contextmenu",
      (event: MouseEvent) => {
        const current = this.contextMenuHandler;
        if (!current) return;
        event.preventDefault();
        current({ x: event.clientX, y: event.clientY });
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

  async search(query: string): Promise<SearchHit[]> {
    const doc = this.doc;
    if (!doc || query.trim() === "") return [];
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str).join(" ");
      const lower = text.toLowerCase();
      let fromIndex = 0;
      while (true) {
        const at = lower.indexOf(needle, fromIndex);
        if (at === -1) break;
        const start = Math.max(0, at - 40);
        const end = Math.min(text.length, at + needle.length + 40);
        hits.push({ excerpt: text.slice(start, end), locator: { kind: "pdf", page: pageNumber } });
        fromIndex = at + needle.length;
      }
    }
    return hits;
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
    this.pageEls = [];
    this.scrollEl = null;
    this.doc = null;
    this.pdfjs = null;
    this.container = null;
    this.highlights = [];
    if (this.workerBlobUrl !== null) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }
}

export function createPdfEngine(app: App, options: PdfEngineOptions): ReaderEngine {
  return new PdfEngine(app, options);
}
