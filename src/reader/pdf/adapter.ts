// PDF adapter, built on pdf.js's own viewer.
//
// This used to lay pages out by hand: placeholder divs, an IntersectionObserver
// to decide the current page, manual scale arithmetic, a manually constructed
// text layer. Every one of those was a re-implementation of something
// pdfjs-dist already ships in `web/pdf_viewer.mjs`, and each was subtly wrong
// — fit-to-width measured the box before its scrollbar existed, the "current"
// page was whichever the observer reported last rather than the topmost, and
// zooming restored to that wrong page. PDFViewer does all of it correctly,
// including re-applying a NAMED scale ("page-width") through its own
// ResizeObserver, which is the part that makes a phone rotation behave.
//
// Obsidian's built-in PDF view is built on the same components, but on an
// older pdf.js — its `app.css` has no trace of pdf.js 6's markup — so none of
// its global styling is relied on here. The layout rules come from the
// pdfjs-dist we bundle, scoped to `.ereader-pdf-host` by
// scripts/sync-pdf-css.mjs, which both keeps us off the built-in viewer's
// toes and outranks the app's global rules where they overlap.
//
// pdfjs-dist is imported dynamically, so none of it is evaluated until a PDF
// is opened (Principle V). No pdfjs type may leak past this module — callers
// only see ReaderEngine and friends (../engine.ts).

import { type App, Platform } from "obsidian";
import type { PdfFit } from "../../settings/settings-model";
import type { Locator } from "../../core/types";
import { activeRange, rangeForQuote, searchableText, snapshotFromRange } from "../dom-selection";
import type { DisplayOption, EngineSelection, OutlineNode, PageState, PaintedHighlight, ReaderEngine, SearchHit } from "../engine";
import { type Point, isPinchWorthApplying, pinchDistance, pinchScale } from "../pinch";
import { pdfPageToPercent } from "../progress";
import type { SpreadMode } from "../spread";
import { clampScale } from "../zoom";

interface PdfjsTextItem {
  str: string;
}

interface PdfjsPage {
  getTextContent(): Promise<{ items: PdfjsTextItem[] }>;
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
  destroy(): Promise<void>;
}

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(opts: { data: ArrayBuffer }): { promise: Promise<PdfjsDocument> };
}

/** pdf.js's own event channel between the viewer and its host. */
interface PdfjsEventBus {
  on(event: string, handler: (payload: Record<string, unknown>) => void): void;
}

interface PdfjsPageView {
  /** The `.page` element, which carries `data-page-number`. */
  div: HTMLElement;
  textLayer: { div: HTMLElement } | null;
}

interface PdfjsViewer {
  currentPageNumber: number;
  readonly currentScale: number;
  currentScaleValue: string;
  spreadMode: number;
  getPageView(index: number): PdfjsPageView | undefined;
  setDocument(doc: PdfjsDocument | null): void;
}

interface PdfjsLinkService {
  setViewer(viewer: PdfjsViewer): void;
  setDocument(doc: PdfjsDocument | null, baseUrl?: unknown): void;
}

interface PdfjsViewerModule {
  EventBus: new () => PdfjsEventBus;
  PDFViewer: new (options: Record<string, unknown>) => PdfjsViewer;
  PDFLinkService: new (options: { eventBus: PdfjsEventBus }) => PdfjsLinkService;
  SpreadMode: { NONE: number; ODD: number; EVEN: number };
}

export interface PdfPreferences {
  scale: number;
  fit: PdfFit;
  spread: SpreadMode;
  adaptToTheme: boolean;
}

export interface PdfEngineOptions extends PdfPreferences {
  onPreferencesChanged(preferences: PdfPreferences): void;
}

/** Loads pdf.js, its viewer and its worker source on first use, once per session. */
let pdfjsPromise: Promise<{ lib: PdfjsModule; viewer: PdfjsViewerModule; workerSource: string }> | null = null;

function loadPdfjs(): Promise<{ lib: PdfjsModule; viewer: PdfjsViewerModule; workerSource: string }> {
  pdfjsPromise ??= (async () => {
    const [lib, viewer, worker] = await Promise.all([
      import("pdfjs-dist") as Promise<unknown>,
      import("pdfjs-dist/web/pdf_viewer.mjs") as Promise<unknown>,
      import("pdfjs-dist/build/pdf.worker.min.mjs"),
    ]);
    return { lib: lib as PdfjsModule, viewer: viewer as PdfjsViewerModule, workerSource: worker.default };
  })();
  return pdfjsPromise;
}

async function resolveDestPage(doc: PdfjsDocument, item: PdfjsOutlineItem): Promise<number | null> {
  try {
    const explicitDest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
    const ref = explicitDest?.[0];
    if (ref === undefined || ref === null) return null;
    return (await doc.getPageIndex(ref)) + 1;
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
    nodes.push({ label: item.title, locator: { kind: "pdf", page: page ?? 1 }, children });
  }
  return nodes;
}

/** pdf.js's name for each of our fit modes. */
function scaleValueFor(fit: PdfFit, scale: number): string {
  if (fit === "width") return "page-width";
  if (fit === "height") return "page-height";
  return String(clampScale(scale));
}

export class PdfEngine implements ReaderEngine {
  private doc: PdfjsDocument | null = null;
  private hostEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private viewer: PdfjsViewer | null = null;
  private linkService: PdfjsLinkService | null = null;
  private workerBlobUrl: string | null = null;
  private contextMenuHandler: ((position: { x: number; y: number }) => void) | null = null;
  private selectionEndHandler: (() => void) | null = null;
  private changeHandler: (() => void) | null = null;
  private highlights: readonly PaintedHighlight[] = [];
  private fit: PdfFit;
  private scaleValue: number;
  private spread: SpreadMode;
  private themed: boolean;
  private spreadModes: PdfjsViewerModule["SpreadMode"] | null = null;
  /** Owns every listener this engine attaches; aborted in destroy (Principle II). */
  private listeners: AbortController | null = null;

  constructor(
    private readonly app: App,
    private readonly options: PdfEngineOptions,
  ) {
    this.scaleValue = clampScale(options.scale);
    this.fit = options.fit;
    this.spread = options.spread;
    this.themed = options.adaptToTheme;
  }

  async open(path: string, container: HTMLElement): Promise<void> {
    this.destroy();
    this.listeners = new AbortController();

    const { lib, viewer: viewerModule, workerSource } = await loadPdfjs();
    this.spreadModes = viewerModule.SpreadMode;
    this.workerBlobUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    lib.GlobalWorkerOptions.workerSrc = this.workerBlobUrl;

    // PDFViewer insists its container be absolutely positioned, so it gets a
    // relatively-positioned host of its own to sit in.
    const hostEl = container.createDiv({ cls: "ereader-pdf-host" });
    hostEl.toggleClass("is-themed", this.themed);
    const scrollEl = hostEl.createDiv({ cls: "ereader-pdf-scroll" });
    const viewerEl = scrollEl.createDiv({ cls: "pdfViewer" });
    this.hostEl = hostEl;
    this.scrollEl = scrollEl;

    const eventBus = new viewerModule.EventBus();
    const linkService = new viewerModule.PDFLinkService({ eventBus });
    const viewer = new viewerModule.PDFViewer({
      container: scrollEl,
      viewer: viewerEl,
      eventBus,
      linkService,
      // `textLayerMode` is deliberately NOT passed: TextLayerMode is internal
      // to pdf_viewer.mjs and is not among its exports, so reaching for it
      // threw before a page could render. ENABLE is the default anyway.
      //
      // -1 is AnnotationEditorType.DISABLE. Nothing here edits a PDF, and
      // leaving the editor out keeps its UI, its stylesheet and its
      // localisation requirements out with it.
      annotationEditorMode: -1,
    });
    linkService.setViewer(viewer);
    this.viewer = viewer;
    this.linkService = linkService;

    eventBus.on("pagesinit", () => {
      viewer.currentScaleValue = scaleValueFor(this.fit, this.scaleValue);
      viewer.spreadMode = this.spreadModeValue();
      this.changeHandler?.();
    });
    eventBus.on("pagechanging", () => this.changeHandler?.());
    eventBus.on("scalechanging", () => {
      // A named scale resolves to a number here, and after a resize it is a
      // DIFFERENT number, so this is where the current one is captured.
      this.scaleValue = clampScale(viewer.currentScale);
      this.savePreferences();
      this.changeHandler?.();
    });
    // A page's text only exists once its layer has rendered, and pages render
    // lazily as they are scrolled to.
    eventBus.on("textlayerrendered", (payload) => {
      const pageNumber = Number(payload["pageNumber"]);
      if (pageNumber) this.paintPage(pageNumber);
    });

    const data = await this.app.vault.adapter.readBinary(path);
    const doc = await lib.getDocument({ data }).promise;
    this.doc = doc;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);

    this.addSelectionListeners();
    this.addPinchListeners();
  }

  // ------------------------------------------------------------ toolbar

  pageState(): PageState | null {
    if (!this.doc || !this.viewer) return null;
    return { current: this.viewer.currentPageNumber, total: this.doc.numPages, unit: "page" };
  }

  async goToPage(page: number): Promise<void> {
    await this.goTo({ kind: "pdf", page });
  }

  async goTo(locator: Locator): Promise<void> {
    if (locator.kind !== "pdf" || !this.viewer || !this.doc) return;
    this.viewer.currentPageNumber = Math.min(Math.max(1, Math.round(locator.page)), this.doc.numPages);
  }

  currentLocator(): Locator | null {
    if (!this.viewer || !this.doc) return null;
    return { kind: "pdf", page: this.viewer.currentPageNumber };
  }

  pageNumberFor(locator: Locator): number | null {
    return locator.kind === "pdf" ? locator.page : null;
  }

  progress(): number {
    if (!this.doc || !this.viewer) return 0;
    return pdfPageToPercent(this.viewer.currentPageNumber, this.doc.numPages);
  }

  scale(): number {
    return this.viewer?.currentScale ?? this.scaleValue;
  }

  async setScale(scale: number): Promise<void> {
    // Zooming by hand releases the fit, or the next resize would silently
    // undo the reader's choice.
    this.fit = "none";
    this.scaleValue = clampScale(scale);
    if (this.viewer) this.viewer.currentScaleValue = String(this.scaleValue);
    this.savePreferences();
  }

  private setFit(fit: PdfFit, scale?: number): void {
    this.fit = fit;
    if (scale !== undefined) this.scaleValue = clampScale(scale);
    if (this.viewer) this.viewer.currentScaleValue = scaleValueFor(fit, this.scaleValue);
    this.savePreferences();
    this.changeHandler?.();
  }

  private spreadModeValue(): number {
    const modes = this.spreadModes;
    if (!modes) return 0;
    return this.spread === "odd" ? modes.ODD : this.spread === "even" ? modes.EVEN : modes.NONE;
  }

  onChange(handler: () => void): void {
    this.changeHandler = handler;
  }

  displayOptions(): DisplayOption[] {
    const spreadOption = (mode: SpreadMode, label: string, icon: string): DisplayOption => ({
      section: "spread",
      id: `spread-${mode}`,
      label,
      icon,
      checked: this.spread === mode,
      apply: () => {
        this.spread = mode;
        if (this.viewer) this.viewer.spreadMode = this.spreadModeValue();
        this.savePreferences();
        this.changeHandler?.();
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
        checked: this.fit === "none" && Math.abs(this.scaleValue - 1) < 0.01,
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
          this.hostEl?.toggleClass("is-themed", this.themed);
          this.savePreferences();
          this.changeHandler?.();
        },
      },
    ];
  }

  private savePreferences(): void {
    this.options.onPreferencesChanged({
      scale: this.scaleValue,
      fit: this.fit,
      spread: this.spread,
      adaptToTheme: this.themed,
    });
  }

  // --------------------------------------------------------- highlights

  async paintHighlights(highlights: readonly PaintedHighlight[]): Promise<void> {
    this.highlights = highlights;
    const doc = this.doc;
    if (!doc) return;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) this.paintPage(pageNumber);
  }

  /**
   * Draws the highlights belonging to one page over its canvas. Only pages
   * pdf.js has actually rendered have a text layer to search; the rest are
   * painted by the `textlayerrendered` handler as they arrive.
   */
  private paintPage(pageNumber: number): void {
    const pageView = this.viewer?.getPageView(pageNumber - 1);
    const textEl = pageView?.textLayer?.div;
    if (!pageView || !textEl) return;

    let layerEl = pageView.div.querySelector<HTMLElement>(".ereader-hl-layer");
    if (!layerEl) {
      layerEl = createDiv({ cls: "ereader-hl-layer" });
      // Between the canvas and the text layer, so selection still works over
      // it and the blend still sees the page beneath.
      pageView.div.insertBefore(layerEl, textEl);
    }
    layerEl.empty();

    const wanted = this.highlights.filter((highlight) => {
      const hint = highlight.hint;
      return hint === undefined || hint.kind !== "pdf" || hint.page === pageNumber;
    });
    if (wanted.length === 0) return;

    const source = searchableText(textEl);
    if (source.index.text === "") return;
    const pageRect = pageView.div.getBoundingClientRect();

    for (const highlight of wanted) {
      const context: { prefix?: string; suffix?: string } = {};
      if (highlight.prefix !== undefined) context.prefix = highlight.prefix;
      if (highlight.suffix !== undefined) context.suffix = highlight.suffix;
      const range = rangeForQuote(source, highlight.exact, context);
      if (!range) continue;
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        const box = layerEl.createDiv({ cls: "ereader-hl" });
        box.dataset["id"] = highlight.id;
        box.dataset["type"] = highlight.type;
        box.style.background = highlight.color;
        box.style.left = `${rect.left - pageRect.left}px`;
        box.style.top = `${rect.top - pageRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
      }
    }
  }

  refreshTheme(): void {
    // A PDF renders in the host document and already follows the vault's
    // theme; the only theme-derived thing is the invert filter, which is CSS.
  }

  // ---------------------------------------------------------- selection

  getSelection(): EngineSelection | null {
    const scrollEl = this.scrollEl;
    if (!scrollEl) return null;
    const range = activeRange(scrollEl.win.getSelection());
    if (!range || !scrollEl.contains(range.commonAncestorContainer)) return null;

    // Context comes from the page the selection starts on: page boundaries
    // are not sentence boundaries, so walking past one would pull in text
    // that does not surround the quote on the page.
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const pageEl = start?.closest<HTMLElement>(".page[data-page-number]") ?? null;
    const snapshot = snapshotFromRange(pageEl ?? scrollEl, range);
    if (!snapshot) return null;
    const page = Number(pageEl?.dataset["pageNumber"] ?? this.viewer?.currentPageNumber ?? 1);
    return { ...snapshot, locator: { kind: "pdf", page: Number.isFinite(page) && page > 0 ? page : 1 } };
  }

  clearSelection(): void {
    this.scrollEl?.win.getSelection()?.removeAllRanges();
  }

  onContextMenu(handler: (position: { x: number; y: number }) => void): void {
    this.contextMenuHandler = handler;
  }

  onSelectionEnd(handler: () => void): void {
    this.selectionEndHandler = handler;
  }

  private addSelectionListeners(): void {
    const scrollEl = this.scrollEl;
    if (!scrollEl) return;
    const options = { signal: this.listeners?.signal };

    scrollEl.addEventListener(
      "contextmenu",
      (event: MouseEvent) => {
        const handler = this.contextMenuHandler;
        if (!handler) return;
        // A long press on a touchscreen fires `contextmenu`, and preventing it
        // cancels the platform's own selection UI along with it — so the press
        // meant to select text would open this menu instead. On touch the menu
        // is only claimed once there is a selection to act on.
        if (Platform.isMobile && this.getSelection() === null) return;
        event.preventDefault();
        handler({ x: event.clientX, y: event.clientY });
      },
      options,
    );

    const fire = (): void => this.selectionEndHandler?.();
    scrollEl.addEventListener("mouseup", fire, options);
    scrollEl.addEventListener("touchend", fire, options);
  }

  /**
   * Pinch to zoom, applied when the fingers lift. Not passive, because the
   * browser's own pinch-zoom has to be refused or the whole app scales.
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
        startScale = this.scale();
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

  // --------------------------------------------------------------- rest

  async outline(): Promise<OutlineNode[]> {
    if (!this.doc) return [];
    const items = await this.doc.getOutline();
    return items ? outlineFromPdf(this.doc, items) : [];
  }

  async search(query: string): Promise<SearchHit[]> {
    const doc = this.doc;
    if (!doc || query.trim() === "") return [];
    const needle = query.toLowerCase();
    const hits: SearchHit[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const content = await (await doc.getPage(pageNumber)).getTextContent();
      const text = content.items.map((item) => item.str).join(" ");
      const lower = text.toLowerCase();
      let fromIndex = 0;
      while (true) {
        const at = lower.indexOf(needle, fromIndex);
        if (at === -1) break;
        hits.push({
          excerpt: text.slice(Math.max(0, at - 40), Math.min(text.length, at + needle.length + 40)),
          locator: { kind: "pdf", page: pageNumber },
        });
        fromIndex = at + needle.length;
      }
    }
    return hits;
  }

  destroy(): void {
    this.listeners?.abort();
    this.listeners = null;
    this.contextMenuHandler = null;
    this.selectionEndHandler = null;
    this.changeHandler = null;
    this.highlights = [];
    this.viewer?.setDocument(null);
    this.linkService?.setDocument(null);
    this.viewer = null;
    this.linkService = null;
    void this.doc?.destroy();
    this.doc = null;
    this.hostEl?.remove();
    this.hostEl = null;
    this.scrollEl = null;
    if (this.workerBlobUrl !== null) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }
}

export function createPdfEngine(app: App, options: PdfEngineOptions): ReaderEngine {
  return new PdfEngine(app, options);
}
