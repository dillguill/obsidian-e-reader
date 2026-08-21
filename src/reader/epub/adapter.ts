// EPUB adapter: foliate-js, loaded lazily so it never enters the startup
// bundle (Principle V / esbuild.config.mjs's `external` list). foliate-js's
// own API note applies here: "the API ... may break and change at any time"
// — so no foliate-js type may leak past this module; callers only see
// ReaderEngine/OutlineNode/SearchHit (../engine.ts).
//
// Electron quirk (verified against other Obsidian plugins hitting the same
// issue): foliate-js renders each section into a sandboxed iframe with
// sandbox="allow-same-origin allow-scripts". Under Obsidian's Electron
// renderer that combination produces a blank iframe — content only renders
// once `allow-scripts` is stripped. foliate-js sets that attribute from
// inside a *closed* shadow root (view.js's `View` and paginator.js's
// `Paginator` both do `attachShadow({ mode: 'closed' })`), so there is no
// public API to reach the iframe afterwards. Instead we intercept the
// `setAttribute('sandbox', ...)` call itself for the lifetime of this
// engine instance and rewrite the value on the way through — see
// `patchIframeSandbox` below.

import type { App, TFile } from "obsidian";
import type { Locator } from "../../core/types";
import type { OutlineNode, ReaderEngine, SearchHit } from "../engine";
import { fractionToPercent } from "../progress";

// Written as "./vendor/..." (relative to the bundled main.js, not to this
// source file) and held in a variable rather than inlined as a string
// literal: esbuild only bundles a dynamic import() when its argument is a
// literal it can statically analyse, and TypeScript only attempts module
// resolution on such a literal too. A variable specifier is invisible to
// both, so this loads lazily at runtime and never touches the tsc/esbuild
// module graphs. (Verified against this repo's esbuild.config.mjs/tsconfig.)
const VIEW_MODULE_PATH = "./vendor/foliate-js/view.js";

interface FoliateLocation {
  cfi?: string;
  fraction?: number;
}

interface FoliateResolvedTarget {
  index: number;
  anchor?: unknown;
}

interface FoliateSearchSubitem {
  cfi: string;
  excerpt: string;
}

interface FoliateSearchResult {
  progress?: number;
  index?: number;
  subitems?: FoliateSearchSubitem[];
}

interface FoliateTocItem {
  label: string;
  href: string;
  subitems?: FoliateTocItem[];
}

interface FoliateBook {
  toc?: FoliateTocItem[];
}

/** The subset of foliate-js's `<foliate-view>` custom element this adapter uses. */
interface FoliateViewElement extends HTMLElement {
  book?: FoliateBook;
  lastLocation?: FoliateLocation;
  open(book: File): Promise<void>;
  init(opts: { lastLocation?: unknown; showTextStart?: boolean }): Promise<void>;
  close(): void;
  goTo(target: string): Promise<unknown>;
  resolveNavigation(target: string): FoliateResolvedTarget | undefined;
  getCFI(index: number, range?: unknown): string;
  search(opts: { query: string }): AsyncGenerator<FoliateSearchResult | "done">;
}

/**
 * Rewrites `sandbox="... allow-scripts ..."` to drop `allow-scripts` for
 * every iframe created while this patch is installed. Scoped to one engine
 * instance's lifetime (installed in `open`, removed in `destroy`) rather
 * than left global — see module doc comment for why a narrower fix (reaching
 * into foliate-js's closed shadow roots) isn't available.
 */
function patchIframeSandbox(): () => void {
  const proto = HTMLIFrameElement.prototype;
  const original = proto.setAttribute;
  // A stable named reference (not `original`) so the restorer below can tell
  // whether *this* patch is still the active one, and only unwinds its own
  // layer — safe even if two EPUBs are open concurrently (e.g. two split
  // panes) and their patch/restore calls interleave.
  const patched: typeof proto.setAttribute = function patchedSetAttribute(
    this: HTMLIFrameElement,
    name: string,
    value: string,
  ): void {
    if (name === "sandbox" && typeof value === "string" && value.includes("allow-scripts")) {
      value = value
        .split(/\s+/)
        .filter((token) => token !== "" && token !== "allow-scripts")
        .join(" ");
    }
    original.call(this, name, value);
  };
  proto.setAttribute = patched;
  return () => {
    if (proto.setAttribute === patched) proto.setAttribute = original;
  };
}

async function outlineFromToc(view: FoliateViewElement, items: FoliateTocItem[]): Promise<OutlineNode[]> {
  const nodes: OutlineNode[] = [];
  for (const item of items) {
    const resolved = view.resolveNavigation(item.href);
    if (!resolved) continue;
    const cfi = view.getCFI(resolved.index);
    const locator: Locator = { kind: "epub", cfi };
    const children = item.subitems && item.subitems.length > 0 ? await outlineFromToc(view, item.subitems) : [];
    nodes.push({ label: item.label, locator, children });
  }
  return nodes;
}

export class EpubEngine implements ReaderEngine {
  private view: FoliateViewElement | null = null;
  private unpatchSandbox: (() => void) | null = null;

  constructor(private readonly app: App) {}

  async open(file: TFile, container: HTMLElement): Promise<void> {
    this.destroy();

    await import(VIEW_MODULE_PATH); // registers the `foliate-view` custom element

    const data = await this.app.vault.readBinary(file);
    const webFile = new File([data], file.name);

    this.unpatchSandbox = patchIframeSandbox();

    const view = document.createElement("foliate-view") as unknown as FoliateViewElement;
    container.appendChild(view);
    await view.open(webFile);
    await view.init({});
    this.view = view;
  }

  async goTo(locator: Locator): Promise<void> {
    if (!this.view || locator.kind !== "epub") return;
    await this.view.goTo(locator.cfi);
  }

  currentLocator(): Locator | null {
    const cfi = this.view?.lastLocation?.cfi;
    return typeof cfi === "string" ? { kind: "epub", cfi } : null;
  }

  progress(): number {
    const fraction = this.view?.lastLocation?.fraction;
    return typeof fraction === "number" ? fractionToPercent(fraction) : 0;
  }

  async outline(): Promise<OutlineNode[]> {
    const view = this.view;
    const toc = view?.book?.toc;
    if (!view || !toc) return [];
    return outlineFromToc(view, toc);
  }

  async search(query: string): Promise<SearchHit[]> {
    const view = this.view;
    if (!view || query.trim() === "") return [];
    const hits: SearchHit[] = [];
    for await (const result of view.search({ query })) {
      if (result === "done") break;
      for (const { cfi, excerpt } of result.subitems ?? []) {
        hits.push({ excerpt, locator: { kind: "epub", cfi } });
      }
    }
    return hits;
  }

  destroy(): void {
    this.view?.close();
    this.view?.remove();
    this.view = null;
    this.unpatchSandbox?.();
    this.unpatchSandbox = null;
  }
}

export function createEpubEngine(app: App): ReaderEngine {
  return new EpubEngine(app);
}
