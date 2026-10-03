// The plugin's settings tab.
//
// Everything here edits the live `plugin.settings` object and saves it; the
// reader, the library view and the sidebar panes all read that object through
// their own `getSettings()` accessor, so a change takes effect on the next
// read without any broadcast. The two exceptions are called out in the
// descriptions below, because they genuinely cannot take effect immediately
// and saying so is better than appearing broken.

import type { App, Plugin, TFolder } from "obsidian";
import { AbstractInputSuggest, Notice, PluginSettingTab, Setting } from "obsidian";
import { RESERVED_ENTRY_TYPE } from "../core/types";
import { DEFAULT_SETTINGS, HIGHLIGHT_PALETTE, type PropertyNames, type ReaderChoice, type Settings } from "./settings-model";

/** What this tab needs from the plugin, beyond being a Plugin. */
export interface SettingsHost {
  settings: Settings;
  saveSettings(): Promise<void>;
  /** Applies the pane toggles right away — detaching a pane that was just turned off. */
  applyPaneSettings(): void;
  /** Imports whatever already sits in the inbox folder. */
  scanInbox(): void;
}

const PROPERTY_FIELDS: { key: keyof PropertyNames; name: string; desc: string }[] = [
  { key: "marker", name: "Book marker property", desc: "The frontmatter property that marks a note as a book." },
  { key: "markerValue", name: "Book marker value", desc: "The value that property must have." },
  { key: "cover", name: "Cover", desc: "Property holding the cover image." },
  { key: "attachments", name: "Attachments", desc: "Property listing the book files attached to a note." },
  { key: "progress", name: "Progress", desc: "Property the reader writes reading progress into, as a percentage." },
  { key: "lastRead", name: "Last read", desc: "Property the reader writes the current position into." },
  { key: "furthestRead", name: "Furthest read", desc: "Property holding the furthest position reached." },
];

const READER_CHOICES: Record<ReaderChoice, string> = {
  plugin: "This plugin's reader",
  default: "Obsidian default",
};

export class EReaderSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: Plugin & SettingsHost,
  ) {
    super(app, host);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.addReaderSection(containerEl);
    this.addSidebarSection(containerEl);
    this.addImportSection(containerEl);
    this.addPropertiesSection(containerEl);
    this.addAnnotationTypesSection(containerEl);
  }

  /**
   * The inbox is scanned when the settings close, not as its folder is
   * typed: every prefix of "Books/Inbox" is a folder too, and "Books" would
   * have imported the whole library a keystroke early.
   */
  override hide(): void {
    super.hide();
    this.host.scanInbox();
  }

  private save(): void {
    void this.host.saveSettings();
  }

  // -------------------------------------------------------------- reader

  private addReaderSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Reader").setHeading();

    new Setting(containerEl)
      .setName("EPUB reader")
      .setDesc(
        "Which reader opens an EPUB. Obsidian has no built-in EPUB viewer, so choosing its default means " +
          "this plugin stops claiming .epub files and they will not open until another plugin claims them. " +
          "Takes effect the next time the plugin loads.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(READER_CHOICES)
          .setValue(this.host.settings.readers.epub)
          .onChange((value) => {
            this.host.settings.readers.epub = value === "default" ? "default" : "plugin";
            this.save();
            new Notice("E-Reader: reload the plugin for the EPUB reader change to take effect.");
          }),
      );

    new Setting(containerEl)
      .setName("PDF reader")
      .setDesc(
        "Which reader opens a PDF book note. A PDF opened from the file explorer always uses Obsidian's " +
          "built-in viewer — a plugin cannot claim the .pdf extension — so this only governs opening a book note.",
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(READER_CHOICES)
          .setValue(this.host.settings.readers.pdf)
          .onChange((value) => {
            this.host.settings.readers.pdf = value === "default" ? "default" : "plugin";
            this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Show saved highlights in the book")
      .setDesc("Paint highlights stored in the book note onto the page. The reader's highlighter button toggles this too.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.reader.showHighlights).onChange((value) => {
          this.host.settings.reader.showHighlights = value;
          this.save();
        }),
      );
  }

  // ------------------------------------------------------------- sidebar

  private addSidebarSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Sidebar").setHeading();

    new Setting(containerEl)
      .setName("Outline pane")
      .setDesc("This plugin's outline pane, which shows a book's table of contents and a note's headings.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.panes.outline).onChange((value) => {
          this.host.settings.panes.outline = value;
          this.save();
          this.host.applyPaneSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Highlights & notes pane")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.panes.highlights).onChange((value) => {
          this.host.settings.panes.highlights = value;
          this.save();
          this.host.applyPaneSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Close Obsidian's outline pane on startup")
      .setDesc(
        "Useful where two outline tabs crowd the sidebar. Obsidian's core plugins cannot be disabled by a " +
          "plugin, so this closes its outline pane once when the vault opens and saves the layout — " +
          "reopening it during a session will stick.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.panes.hideNativeOutline).onChange((value) => {
          this.host.settings.panes.hideNativeOutline = value;
          this.save();
          this.host.applyPaneSettings();
        }),
      );
  }

  // -------------------------------------------------------------- import

  private addImportSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Import").setHeading();
    const settings = this.host.settings.import;

    const folderSetting = (
      name: string,
      desc: string,
      placeholder: string,
      get: () => string,
      set: (value: string) => void,
    ): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) => {
          text
            .setPlaceholder(placeholder)
            .setValue(get())
            .onChange((value) => {
              set(value.trim().replace(/^\/+|\/+$/g, ""));
              this.save();
            });
          new FolderSuggest(this.app, text.inputEl);
        });
    };

    folderSetting(
      "Book notes folder",
      "Where a new book's note is created. Empty puts it at the root of the vault.",
      "Library",
      () => settings.notesFolder,
      (value) => (settings.notesFolder = value),
    );
    folderSetting(
      "Book files folder",
      "Where the EPUB or PDF and its cover are moved. Empty follows Obsidian's own setting for new attachments.",
      "Obsidian's attachment location",
      () => settings.filesFolder,
      (value) => (settings.filesFolder = value),
    );
    folderSetting(
      "Inbox folder",
      "EPUBs that land here are imported automatically; for PDFs you are asked which are books. Empty turns this off.",
      "Off",
      () => settings.inboxFolder,
      (value) => (settings.inboxFolder = value),
    );

    new Setting(containerEl)
      .setName("Look up missing details")
      .setDesc(
        "Ask Open Library for what a file does not say about itself: author, ISBN, page count, subjects, cover. " +
          "Sends the title and author, or the ISBN, to openlibrary.org. Never overrides what the file says.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.lookUpMetadata).onChange((value) => {
          settings.lookUpMetadata = value;
          this.save();
        }),
      );
  }

  // ---------------------------------------------------------- properties

  private addPropertiesSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Properties")
      .setDesc("Frontmatter property names this plugin reads and writes. Leave a field empty to use its default.")
      .setHeading();

    for (const field of PROPERTY_FIELDS) {
      new Setting(containerEl)
        .setName(field.name)
        .setDesc(field.desc)
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.properties[field.key])
            .setValue(this.host.settings.properties[field.key])
            .onChange((value) => {
              const trimmed = value.trim();
              this.host.settings.properties[field.key] =
                trimmed === "" ? DEFAULT_SETTINGS.properties[field.key] : trimmed;
              this.save();
            }),
        );
    }
  }

  // ---------------------------------------------------- annotation types

  private addAnnotationTypesSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Highlight types")
      .setDesc(
        `The highlight kinds offered when annotating. "${RESERVED_ENTRY_TYPE}" is reserved for bookmarks and ` +
          "cannot be used here.",
      )
      .setHeading();

    const types = this.host.settings.annotationTypes;
    types.forEach((type, index) => {
      new Setting(containerEl)
        .addText((text) =>
          text.setValue(type.name).onChange((value) => {
            const trimmed = value.trim();
            if (trimmed === RESERVED_ENTRY_TYPE) {
              new Notice(`E-Reader: "${RESERVED_ENTRY_TYPE}" is reserved for bookmarks.`);
              return;
            }
            if (trimmed === "") return;
            // A rename has to carry the active choice with it, or the
            // "Highlight selection" command would silently fall back to the
            // first type.
            if (this.host.settings.reader.activeAnnotationType === type.name) {
              this.host.settings.reader.activeAnnotationType = trimmed;
            }
            type.name = trimmed;
            this.save();
          }),
        )
        .addColorPicker((picker) =>
          picker.setValue(type.color).onChange((value) => {
            type.color = value;
            this.save();
          }),
        )
        .addExtraButton((button) =>
          button
            .setIcon("trash-2")
            .setTooltip("Remove")
            .onClick(() => {
              types.splice(index, 1);
              if (this.host.settings.reader.activeAnnotationType === type.name) {
                this.host.settings.reader.activeAnnotationType = types[0]?.name ?? "";
              }
              this.save();
              this.display();
            }),
        );
    });

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Add highlight type")
        .setCta()
        .onClick(() => {
          const name = uniqueTypeName(types.map((type) => type.name));
          types.push({ name, color: HIGHLIGHT_PALETTE[types.length % HIGHLIGHT_PALETTE.length] as string });
          if (this.host.settings.reader.activeAnnotationType === "") {
            this.host.settings.reader.activeAnnotationType = name;
          }
          this.save();
          this.display();
        }),
    );
  }
}

/** `note`, then `note 2`, `note 3`… so a second Add does not collide with the first. */
function uniqueTypeName(existing: string[]): string {
  const base = "note";
  if (!existing.includes(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/** Suggests the vault's folders as a folder path is typed. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(
    app: App,
    private readonly input: HTMLInputElement,
  ) {
    super(app, input);
  }

  protected getSuggestions(query: string): TFolder[] {
    const wanted = query.toLowerCase();
    return this.app.vault
      .getAllFolders(false)
      .filter((folder) => folder.path.toLowerCase().includes(wanted))
      .slice(0, 20);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  override selectSuggestion(folder: TFolder): void {
    this.setValue(folder.path);
    this.input.dispatchEvent(new Event("input"));
    this.close();
  }
}
