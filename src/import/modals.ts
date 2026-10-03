// The two pickers behind wishlist books: finding a book to add (an Open
// Library search) and choosing the file for one that has arrived (a file in
// the vault, or one from this device).

import type { App, TFile } from "obsidian";
import { FuzzySuggestModal, SuggestModal } from "obsidian";
import type { ImportSource } from "./importer";
import { IMPORTABLE_EXTENSIONS } from "./importer";
import type { BookMetadata } from "./metadata";
import { type OpenLibraryResult, searchOpenLibrary } from "./open-library";

/** Pause after the last keystroke before searching, so typing a title is one request, not one per letter. */
const SEARCH_DELAY_MS = 350;

const FROM_DEVICE = "device";
type FileChoice = TFile | typeof FROM_DEVICE;

/**
 * Picks the file for a book: an EPUB or PDF in the vault that no book has
 * yet, or (the first entry) one from this device. Resolves null when the
 * picker is dismissed.
 */
export function chooseBookFile(app: App, unattached: () => TFile[]): Promise<ImportSource | null> {
  return new Promise((resolve) => new BookFileModal(app, unattached, resolve).open());
}

class BookFileModal extends FuzzySuggestModal<FileChoice> {
  private settled = false;

  constructor(
    app: App,
    private readonly unattached: () => TFile[],
    private readonly resolve: (source: ImportSource | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose the book's EPUB or PDF");
  }

  getItems(): FileChoice[] {
    return [FROM_DEVICE, ...this.unattached().filter((file) => IMPORTABLE_EXTENSIONS.has(file.extension))];
  }

  getItemText(item: FileChoice): string {
    return item === FROM_DEVICE ? "Choose a file from this device…" : item.path;
  }

  onChooseItem(item: FileChoice): void {
    this.settled = true;
    if (item !== FROM_DEVICE) {
      this.resolve({ kind: "vault", file: item });
      return;
    }
    // Clicked within the same gesture that chose the item, which is what
    // lets the system file picker open on mobile.
    const input = activeDocument.createElement("input");
    input.type = "file";
    input.accept = ".epub,.pdf,application/epub+zip,application/pdf";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        this.resolve(null);
        return;
      }
      void file.arrayBuffer().then(
        (data) => this.resolve({ kind: "external", name: file.name, data }),
        () => this.resolve(null),
      );
    });
    input.addEventListener("cancel", () => this.resolve(null));
    input.click();
  }

  override onClose(): void {
    // FuzzySuggestModal closes before it reports the choice, so a dismissal
    // is only certain once that has had its chance to run.
    window.setTimeout(() => {
      if (!this.settled) this.resolve(null);
    }, 0);
  }
}

type WishlistChoice = { kind: "result"; result: OpenLibraryResult } | { kind: "manual"; title: string };

/** What was chosen to add: an Open Library match, or just a typed title when the book is not there. */
export type WishlistPick = { meta: BookMetadata; coverUrl: string | null };

export function searchForWishlist(app: App, onPick: (pick: WishlistPick) => void): void {
  new WishlistSearchModal(app, onPick).open();
}

class WishlistSearchModal extends SuggestModal<WishlistChoice> {
  private searchToken = 0;

  constructor(
    app: App,
    private readonly onPick: (pick: WishlistPick) => void,
  ) {
    super(app);
    this.setPlaceholder("Search Open Library by title, author or ISBN");
    this.emptyStateText = "Type a title, author or ISBN.";
  }

  async getSuggestions(query: string): Promise<WishlistChoice[]> {
    const trimmed = query.trim();
    if (trimmed === "") return [];
    const token = ++this.searchToken;
    await new Promise((resolve) => window.setTimeout(resolve, SEARCH_DELAY_MS));
    // A newer keystroke has started its own search; this one's answer would be stale.
    if (token !== this.searchToken) return [];
    const manual: WishlistChoice = { kind: "manual", title: trimmed };
    try {
      const results = await searchOpenLibrary(trimmed);
      return [...results.map((result): WishlistChoice => ({ kind: "result", result })), manual];
    } catch (error) {
      console.debug("[e-reader] Open Library search failed", error);
      return [manual];
    }
  }

  renderSuggestion(choice: WishlistChoice, el: HTMLElement): void {
    if (choice.kind === "manual") {
      el.createDiv({ text: `Add “${choice.title}” without details` });
      el.createEl("small", { cls: "ereader-suggestion__detail", text: "For a book Open Library does not have" });
      return;
    }
    const { meta } = choice.result;
    el.createDiv({ text: meta.title });
    const detail = [meta.authors.join(", "), meta.published].filter((part) => part !== undefined && part !== "").join(" · ");
    if (detail !== "") el.createEl("small", { cls: "ereader-suggestion__detail", text: detail });
  }

  onChooseSuggestion(choice: WishlistChoice): void {
    if (choice.kind === "manual") this.onPick({ meta: { title: choice.title, authors: [], subjects: [] }, coverUrl: null });
    else this.onPick(choice.result);
  }
}
