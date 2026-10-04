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
// in esbuild.config.mjs loads pdfjs-dist/legacy/build/pdf.worker.min.mjs as a
// string) and turned into a same-origin blob: URL at runtime instead.
//
// No pdfjs type may leak past this module — callers only see
// ReaderEngine/OutlineNode/PageState/... (../engine.ts).

import type { App } from "obsidian";
import type { Locator } from "../../core/types";
import { activeRange, rangeForQuote, searchableText, snapshotFromRange } from "../dom-selection";
import { mergeHighlightBoxes } from "../highlight-rects";
import type {
  DisplayOption,
  EngineSelection,
  OutlineNode,
  PageState,
  PaintedHighlight,
  ReaderEngine,
} from "../engine";
import { pdfPageToPercent } from "../progress";
import { type SearchHandlers, findMatches, hitFromText, yieldToUi } from "../search";
import { buildTextIndex } from "../text-index";
import { type Point, isPinchWorthApplying, pinchDistance, pinchScale } from "../pinch";
import { type SpreadMode, adjacentRowPage, spreadRows } from "../spread";
import type { PdfFit } from "../../settings/settings-model";
import { clampScale, fitRowSize, fitScale } from "../zoom";

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsTextItem {
  str: string;
  /** Set on the last item of a line. Marked-content items carry neither field. */
  hasEOL?: boolean;
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
  getMetadata(): Promise<{ info: Record<string, unknown> | null }>;
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

/**
 * pdf.js's legacy build, not its default one. The default build calls
 * JavaScript that Obsidian's runtimes (its Electron, and iOS's WebKit) do not
 * ship yet — `Map.prototype.getOrInsertComputed`, `Uint8Array.prototype.toHex`
 * and more — and failed on real PDFs with "is not a function". The legacy
 * build is the same library with those polyfilled, in the worker too.
 */
function loadPdfjs(): Promise<{ lib: PdfjsModule; workerSource: string }> {
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<unknown>,
      import("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    ]);
    return { lib: lib as PdfjsModule, workerSource: worker.default };
  })();
  return pdfjsPromise;
}

/** Width in CSS pixels a PDF's first page is drawn at to become its cover. */
const PDF_COVER_WIDTH = 600;

/**
 * What a PDF says about itself — its info dictionary's Title and Author, and
 * its page count — plus its first page drawn as a cover. Lives here so pdf.js
 * stays inside this module; the importer only sees plain values.
 */
export async function readPdfMetadata(data: ArrayBuffer): Promise<{
  title: string | null;
  authors: string[];
  subject: string | null;
  pages: number;
  cover: ArrayBuffer | null;
}> {
  const { lib, workerSource } = await loadPdfjs();
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  // pdf.js takes ownership of the buffer it is given, detaching it; the
  // caller still needs its bytes to write the file.
  const task = lib.getDocument({ data: data.slice(0) });
  try {
    const doc = await task.promise;
    // A PDF whose info dictionary cannot be read still imports. This has to
    // be a try, not a .catch: a failure inside getMetadata can throw before
    // it returns a promise.
    let info: Record<string, unknown> | null = null;
    try {
      info = (await doc.getMetadata()).info;
    } catch (error) {
      console.debug("[e-reader] could not read a PDF's info dictionary", error);
    }
    const text = (key: string): string | null => {
      const value = info?.[key];
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    };
    const author = text("Author");
    let cover: ArrayBuffer | null = null;
    try {
      const page = await doc.getPage(1);
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PDF_COVER_WIDTH / unscaled.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
        cover = blob ? await blob.arrayBuffer() : null;
      }
    } catch (error) {
      console.debug("[e-reader] could not draw a PDF's first page as its cover", error);
    }
    return {
      title: text("Title"),
      // Info dictionaries hold one string. Several authors are split on
      // semicolons, "&" and "and" — not commas, which also separate a
      // surname from its initials ("Tolkien, J. R. R.").
      authors: author ? author.split(/\s*(?:;|&|\band\b)\s*/).filter((name) => name !== "") : [],
      subject: text("Subject"),
      pages: doc.numPages,
      cover,
    };
  } finally {
    await task.destroy().catch(() => undefined);
    URL.revokeObjectURL(workerUrl);
  }
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
  private tapHandler: ((position: { x: number; y: number }) => void) | null = null;
  private selectionEndHandler: (() => void) | null = null;
  private selectionChangeHandler: (() => void) | null = null;
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

  async turnPage(direction: 1 | -1): Promise<void> {
    if (!this.doc) return;
    const target = adjacentRowPage(spreadRows(this.doc.numPages, this.spread), this.currentPage, direction);
    if (target !== null) await this.goTo({ kind: "pdf", page: target });
  }

  onKeyDown(_handler: (event: KeyboardEvent) => boolean): void {
    // A PDF renders in the host document, where the view's own Scope already
    // hears every key press; there is no inner document to forward from.
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
        // The whole page in view, which is pdf.js's `page-fit` rather than
        // its `page-actual`. A true 100% is still reachable by stepping the
        // zoom, but it is not what is wanted from this option: a page at 100%
        // is taller than any pane it is read in, so choosing it left the
        // reader part-way down a page with no way to see the rest of it.
        checked: this.fit === "page",
        apply: () => this.setFit("page"),
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
      for (const rect of mergeHighlightBoxes(Array.from(range.getClientRects()))) {
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
        box.style.width = `${rect.right - rect.left}px`;
        box.style.height = `${rect.bottom - rect.top}px`;
      }
    }
  }

  /**
   * Reads each page's text content — not the rendered text layer, which only
   * exists for pages already drawn — and reports every match on it. A
   * match's page is all the locator carries; the quote and its context are
   * what find it again on the page once that page is drawn.
   */
  async search(query: string, handlers: SearchHandlers, signal: AbortSignal): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      if (signal.aborted) return;
      try {
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        if (signal.aborted) return;
        // Items are runs on a line; a line break separates words the same
        // way the text layer's own `<br>` does.
        const text = buildTextIndex(
          content.items.map((item) => ({ text: `${item.str ?? ""}${item.hasEOL ? "\n" : ""}` })),
        ).text;
        for (const match of findMatches(text, query)) {
          if (!handlers.hit(hitFromText(text, match, { kind: "pdf", page: pageNumber }))) return;
        }
      } catch (error) {
        console.debug("[e-reader] could not search a page", pageNumber, error);
      }
      handlers.progress(pageNumber / doc.numPages);
      // Every page, so the reader can scroll while a long document is searched.
      await yieldToUi();
    }
  }

  setTypography(): void {
    // A PDF's text is set by the document itself.
  }

  onLinkFollowed(): void {
    // Links inside a PDF are not followed by this reader.
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

  onTap(handler: (position: { x: number; y: number }) => void): void {
    this.tapHandler = handler;
    const scrollEl = this.scrollEl;
    if (!scrollEl) return;
    scrollEl.addEventListener(
      "click",
      (event: MouseEvent) => {
        // Following a link is not a tap on the page.
        if (event.target instanceof Element && event.target.closest("a[href]")) return;
        this.tapHandler?.({ x: event.clientX, y: event.clientY });
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

  onSelectionChange(handler: () => void): void {
    this.selectionChangeHandler = handler;
    const scrollEl = this.scrollEl;
    if (!scrollEl) return;
    // `selectionchange` fires on the document only. A change anywhere else in
    // the app arrives here too; the handler reads the selection back through
    // getSelection, which only reports one inside this book.
    scrollEl.doc.addEventListener("selectionchange", () => this.selectionChangeHandler?.(), {
      signal: this.listeners?.signal,
    });
  }

  selectionRect(): { left: number; top: number; right: number; bottom: number } | null {
    const scrollEl = this.scrollEl;
    if (!scrollEl) return null;
    const range = activeRange(scrollEl.win.getSelection());
    if (!range || !scrollEl.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }

  async outline(): Promise<OutlineNode[]> {
    if (!this.doc) return [];
    const items = await this.doc.getOutline();
    if (!items) return [];
    return outlineFromPdf(this.doc, items);
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.listeners?.abort();
    this.listeners = null;
    this.contextMenuHandler = null;
    this.tapHandler = null;
    this.selectionEndHandler = null;
    this.selectionChangeHandler = null;
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
    if (this.workerBlobUrl !== null) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }
}

export function createPdfEngine(app: App, options: PdfEngineOptions): ReaderEngine {
  return new PdfEngine(app, options);
}
