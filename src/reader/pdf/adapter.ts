// PDF adapter: pdfjs-dist, statically imported and bundled straight into
// main.js (see esbuild.config.mjs — no vendor dir, no dynamic import(), no
// vault.adapter.getResourcePath() resource-path resolution).
//
// pdf.js needs its worker script served from a URL it can spin up a Worker
// from; there is no vendor/ directory to point at anymore, so the worker's
// minified source is inlined into main.js as a text asset (an esbuild plugin
// in esbuild.config.mjs loads pdfjs-dist/build/pdf.worker.min.mjs as a
// string) and turned into a same-origin blob: URL at runtime instead.
//
// No pdfjs type may leak past this module — callers only see
// ReaderEngine/OutlineNode/SearchHit (../engine.ts).

import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerSource from "pdfjs-dist/build/pdf.worker.min.mjs";
import type { App, TFile } from "obsidian";
import type { Locator } from "../../core/types";
import type { OutlineNode, ReaderEngine, SearchHit } from "../engine";
import { pdfPageToPercent } from "../progress";

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

const RENDER_SCALE = 1.5;

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
  private canvas: HTMLCanvasElement | null = null;
  private textLayerEl: HTMLElement | null = null;
  private currentPage = 1;
  private renderToken = 0;
  private workerBlobUrl: string | null = null;

  constructor(private readonly app: App) {}

  async open(file: TFile, container: HTMLElement): Promise<void> {
    this.destroy();

    const pdfjsModule = pdfjsLib as unknown as PdfjsModule;
    const blob = new Blob([pdfWorkerSource], { type: "text/javascript" });
    this.workerBlobUrl = URL.createObjectURL(blob);
    pdfjsModule.GlobalWorkerOptions.workerSrc = this.workerBlobUrl;

    const data = await this.app.vault.readBinary(file);
    const loadingTask = pdfjsModule.getDocument({ data });
    this.doc = await loadingTask.promise;

    this.container = container;
    const viewport = container.createDiv({ cls: "ereader-reader__pdf-viewport" });
    this.canvas = viewport.createEl("canvas", { cls: "ereader-reader__pdf-canvas" });
    this.textLayerEl = viewport.createDiv({ cls: "ereader-reader__pdf-text-layer" });

    await this.renderPage(1);
  }

  async goTo(locator: Locator): Promise<void> {
    if (locator.kind !== "pdf" || !this.doc) return;
    const page = Math.min(Math.max(1, Math.round(locator.page)), this.doc.numPages);
    await this.renderPage(page);
  }

  currentLocator(): Locator | null {
    if (!this.doc) return null;
    return { kind: "pdf", page: this.currentPage };
  }

  progress(): number {
    if (!this.doc) return 0;
    return pdfPageToPercent(this.currentPage, this.doc.numPages);
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
    this.doc = null;
    this.canvas = null;
    this.textLayerEl = null;
    this.container = null;
    this.renderToken++;
    if (this.workerBlobUrl !== null) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }

  private async renderPage(pageNumber: number): Promise<void> {
    const doc = this.doc;
    const canvas = this.canvas;
    const textLayerEl = this.textLayerEl;
    if (!doc || !canvas || !textLayerEl) return;

    const token = ++this.renderToken;
    const page = await doc.getPage(pageNumber);
    if (token !== this.renderToken) return;

    const viewport = page.getViewport({ scale: RENDER_SCALE });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (token !== this.renderToken) return;

    textLayerEl.replaceChildren();
    textLayerEl.style.width = `${viewport.width}px`;
    textLayerEl.style.height = `${viewport.height}px`;
    const textLayer = new (pdfjsLib as unknown as PdfjsModule).TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerEl,
      viewport,
    });
    await textLayer.render();
    if (token !== this.renderToken) return;

    this.currentPage = pageNumber;
  }
}

export function createPdfEngine(app: App): ReaderEngine {
  return new PdfEngine(app);
}
