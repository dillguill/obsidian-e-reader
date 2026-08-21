# Contract: Internal Reader Engine Interface

**Purpose**: Insulate the plugin from both rendering engines. foliate-js warns its API may "break and
change at any time" (R2), so no engine type may appear outside its adapter.

```ts
interface ReaderEngine {
  open(file: TFile, container: HTMLElement): Promise<BookHandle>;
}

interface BookHandle {
  goTo(locator: Locator): Promise<void>;
  currentLocator(): Locator;
  progress(): number;                      // 0–100, FR-015

  outline(): Promise<OutlineNode[]>;       // FR-025; empty array ⇒ FR-027 empty state
  search(query: string): AsyncIterable<SearchHit>;   // FR-016, streamed so large books stay responsive

  selection(): Selection | null;           // FR-016
  resolve(anchor: AnchorRecord): Promise<Locator | null>;  // null ⇒ unanchored, FR-024
  paint(anchors: ResolvedAnchor[]): void;  // FR-016b, persistent rendering
  clear(id: string): void;

  setTextSize(scale: number): void;        // FR-017, reflowable only
  setZoom(scale: number): void;            // FR-017, fixed-page only
  destroy(): void;                         // Principle II — leaves nothing behind
}
```

## Rules

- Two implementations: `EpubEngine` (foliate-js) and `PdfEngine` (pdfjs-dist). Nothing else may
  import either library.
- Both are loaded via dynamic `import()` on first use, never at startup (FR-014d, Principle V).
- `setTextSize` on a fixed-page book and `setZoom` on a reflowable one are no-ops, not errors.
- `destroy()` must release the worker, listeners, and object URLs so unload is clean (Principle II).
- Engine failures surface as typed errors naming the file, never as thrown internals (Edge Cases).
