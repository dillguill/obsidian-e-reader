// EPUB adapter: epub.js, statically imported and bundled straight into
// main.js (see esbuild.config.mjs — no vendor dir, no dynamic import(),
// no vault.adapter.getResourcePath() resource-path resolution, all of which
// previously failed at runtime with "Failed to fetch dynamically imported
// module" and rendered EPUBs blank).
//
// epub.js's own .d.ts (node_modules/epubjs/types) is incomplete/wrong in
// places verified against node_modules/epubjs/src (e.g. Section.find's
// declared return type of Element[] doesn't match its actual {cfi, excerpt}[]
// return — see section.js's find()). This module declares its own minimal,
// verified contract for the pieces it uses and casts epub.js's runtime
// objects onto it, rather than trusting the shipped types outright. No
// epub.js type may leak past this module — callers only see
// ReaderEngine/OutlineNode/SearchHit (../engine.ts).

import ePub from "epubjs";
import type { App, TFile } from "obsidian";
import type { Locator } from "../../core/types";
import type { OutlineNode, ReaderEngine, SearchHit } from "../engine";
import { fractionToPercent } from "../progress";

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

interface EpubLocations {
  generate(chars: number): Promise<string[]>;
  percentageFromCfi(cfi: string): number;
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

interface EpubRendition {
  display(target?: string): Promise<void>;
  on(event: "relocated", callback: (location: EpubCurrentLocation) => void): void;
  destroy(): void;
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

export class EpubEngine implements ReaderEngine {
  private book: EpubBook | null = null;
  private rendition: EpubRendition | null = null;
  private lastCfi: string | null = null;

  constructor(private readonly app: App) {}

  async open(file: TFile, container: HTMLElement): Promise<void> {
    this.destroy();

    const data = await this.app.vault.readBinary(file);
    const book = ePub(data) as unknown as EpubBook;
    this.book = book;
    await book.ready;

    const rendition = book.renderTo(container, { width: "100%", height: "100%" });
    this.rendition = rendition;
    rendition.on("relocated", (location) => {
      this.lastCfi = location.start.cfi;
    });

    await rendition.display();

    // Whole-book percentage needs the character-offset index epub.js builds
    // by walking every section; that's too slow to block open() on, so it
    // runs in the background and progress() degrades to 0 until it settles.
    void book.locations.generate(LOCATIONS_GENERATE_CHARS).catch((error: unknown) => {
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
    this.rendition?.destroy();
    this.rendition = null;
    this.book?.destroy();
    this.book = null;
    this.lastCfi = null;
  }
}

export function createEpubEngine(app: App): ReaderEngine {
  return new EpubEngine(app);
}
