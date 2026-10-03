// Lists the books that appear more than once in the library and lets the
// reader merge each group into the note they want to keep. Merging moves
// everything into that note and trashes the rest (store.ts mergeBookInto),
// so it asks once more before doing it.

import type { App, TFile } from "obsidian";
import { Modal, Setting } from "obsidian";

export interface DuplicateBook {
  note: TFile;
  /** False for a book note with no file yet. */
  hasFile: boolean;
}

export class DuplicatesModal extends Modal {
  constructor(
    app: App,
    private groups: DuplicateBook[][],
    private readonly merge: (keep: TFile, others: TFile[]) => Promise<boolean>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.groups.length === 0) {
      this.setTitle("No duplicate books");
      contentEl.createEl("p", { text: "Every book in your library appears once." });
      return;
    }
    this.setTitle(this.groups.length === 1 ? "1 book appears more than once" : `${this.groups.length} books appear more than once`);
    contentEl.createEl("p", {
      text:
        "Keep one note per book. Its highlights, properties and text gain the others', " +
        "and the others go to the trash.",
      cls: "setting-item-description",
    });
    for (const group of this.groups) {
      new Setting(contentEl).setName(group[0]?.note.basename ?? "").setHeading();
      for (const book of group) this.renderBook(contentEl, group, book);
    }
  }

  private renderBook(containerEl: HTMLElement, group: DuplicateBook[], book: DuplicateBook): void {
    let confirming = false;
    new Setting(containerEl)
      .setName(book.note.path)
      .setDesc(book.hasFile ? "" : "No file yet")
      .addButton((button) =>
        button.setButtonText("Open").onClick(() => {
          void this.app.workspace.getLeaf(true).openFile(book.note);
        }),
      )
      .addButton((button) =>
        button.setButtonText("Keep this").onClick(async () => {
          if (!confirming) {
            confirming = true;
            button.setButtonText("Merge the others into this").setWarning();
            return;
          }
          button.setDisabled(true);
          const others = group.filter((item) => item !== book).map((item) => item.note);
          if (await this.merge(book.note, others)) {
            this.groups = this.groups.filter((item) => item !== group);
            this.render();
          } else button.setDisabled(false);
        }),
      );
  }
}
