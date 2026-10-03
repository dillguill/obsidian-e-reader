// The two steps after choosing a book to add, and behind a card's Change
// cover and Update details: picking a cover from the ones on offer, and
// picking which details go into the note's properties. Either can be skipped.

import type { App, TFile } from "obsidian";
import { FuzzySuggestModal, Modal, Setting } from "obsidian";
import type { BookCover } from "./metadata";
import type { DetailRow } from "./plan";

/** A cover on offer: a picture to show, and how to get the image to save. */
export interface CoverOption {
  src: string;
  label: string;
  load: () => Promise<BookCover | undefined>;
}

/** A chosen cover: an image to save, an image already in the vault, or none. */
export type CoverChoice = { kind: "image"; cover: BookCover } | { kind: "vault"; file: TFile } | { kind: "none" };

export interface CoverPick {
  choice: CoverChoice;
  /** Move the cover being replaced to the trash. */
  removeOld: boolean;
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"]);

/**
 * Asks for a cover. `options` may still be loading; the modal says so until
 * they arrive. Resolves null when dismissed without a choice.
 */
export function pickCover(
  app: App,
  options: Promise<CoverOption[]>,
  context: { title: string; skipLabel: string; oldCover: TFile | null },
): Promise<CoverPick | null> {
  return new Promise((resolve) => new CoverModal(app, options, context, resolve).open());
}

class CoverModal extends Modal {
  private settled = false;
  private removeOld = true;

  constructor(
    app: App,
    private readonly options: Promise<CoverOption[]>,
    private readonly context: { title: string; skipLabel: string; oldCover: TFile | null },
    private readonly resolve: (pick: CoverPick | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(`Choose a cover for “${this.context.title}”`);
    const grid = contentEl.createDiv({ cls: "ereader-cover-grid" });
    const status = grid.createDiv({ cls: "ereader-cover-grid__status", text: "Looking for covers…" });
    void this.options.then(
      (options) => {
        status.remove();
        if (options.length === 0) grid.createDiv({ cls: "ereader-cover-grid__status", text: "No covers found." });
        for (const option of options) this.renderOption(grid, option);
      },
      () => status.setText("Could not look for covers."),
    );

    if (this.context.oldCover) {
      new Setting(contentEl)
        .setName("Delete the old cover")
        .setDesc(`${this.context.oldCover.path} goes to the trash, the way this vault deletes files. Kept if another note uses it.`)
        .addToggle((toggle) => toggle.setValue(this.removeOld).onChange((on) => (this.removeOld = on)));
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Choose an image in the vault…").onClick(() => {
          new VaultImageModal(this.app, (file) => this.finish({ kind: "vault", file })).open();
        }),
      )
      .addButton((button) => button.setButtonText(this.context.skipLabel).onClick(() => this.finish({ kind: "none" })));
  }

  private renderOption(grid: HTMLElement, option: CoverOption): void {
    const tile = grid.createEl("button", { cls: "ereader-cover-grid__option", attr: { "aria-label": option.label, title: option.label } });
    const img = tile.createEl("img", { attr: { src: option.src, alt: "", loading: "lazy" } });
    img.addEventListener("error", () => tile.remove(), { once: true });
    tile.addEventListener("click", () => {
      tile.addClass("is-loading");
      void option.load().then((cover) => {
        if (cover) this.finish({ kind: "image", cover });
        else tile.remove();
      });
    });
  }

  private finish(choice: CoverChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve({ choice, removeOld: this.removeOld });
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
  }
}

class VaultImageModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly onChoose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose an image");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((file) => IMAGE_EXTENSIONS.has(file.extension.toLowerCase()));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}

/** A detail on offer, with what the note says now when it already says something. */
export interface DetailOption extends DetailRow {
  current?: string;
}

/**
 * Asks which details to write. A detail the note lacks starts ticked; one
 * that would replace what the note says starts unticked. Resolves the chosen
 * properties (empty when skipped), or null when dismissed.
 */
export function pickDetails(
  app: App,
  rows: DetailOption[],
  context: { title: string; confirmLabel: string },
): Promise<Set<string> | null> {
  return new Promise((resolve) => new DetailsModal(app, rows, context, resolve).open());
}

class DetailsModal extends Modal {
  private settled = false;
  private readonly chosen = new Set<string>();

  constructor(
    app: App,
    private readonly rows: DetailOption[],
    private readonly context: { title: string; confirmLabel: string },
    private readonly resolve: (chosen: Set<string> | null) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(`Details for “${this.context.title}”`);
    if (this.rows.length === 0) contentEl.createEl("p", { text: "Open Library has no details to add." });
    for (const row of this.rows) {
      if (row.current === undefined) this.chosen.add(row.property);
      const setting = new Setting(contentEl).setName(row.label).setDesc(row.display);
      if (row.current !== undefined) setting.descEl.createDiv({ cls: "ereader-detail-current", text: `Now: ${row.current}` });
      setting.addToggle((toggle) =>
        toggle.setValue(this.chosen.has(row.property)).onChange((on) => {
          if (on) this.chosen.add(row.property);
          else this.chosen.delete(row.property);
        }),
      );
    }
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Skip").onClick(() => this.finish(new Set())))
      .addButton((button) => button.setButtonText(this.context.confirmLabel).setCta().onClick(() => this.finish(this.chosen)));
  }

  private finish(chosen: Set<string>): void {
    this.settled = true;
    this.resolve(chosen);
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
  }
}
