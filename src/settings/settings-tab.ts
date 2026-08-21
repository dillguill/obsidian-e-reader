// The plugin's settings tab.
//
// Everything here edits the live `plugin.settings` object and saves it; the
// reader, the library view and the sidebar panes all read that object through
// their own `getSettings()` accessor, so a change takes effect on the next
// read without any broadcast. The two exceptions are called out in the
// descriptions below, because they genuinely cannot take effect immediately
// and saying so is better than appearing broken.

import type { App, Plugin } from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
import { RESERVED_ENTRY_TYPE } from "../core/types";
import { DEFAULT_SETTINGS, HIGHLIGHT_PALETTE, type PropertyNames, type ReaderChoice, type Settings } from "./settings-model";

/** What this tab needs from the plugin, beyond being a Plugin. */
export interface SettingsHost {
  settings: Settings;
  saveSettings(): Promise<void>;
  /** Applies the pane toggles right away — detaching a pane that was just turned off. */
  applyPaneSettings(): void;
}

const PROPERTY_FIELDS: { key: keyof PropertyNames; name: string; desc: string }[] = [
  { key: "marker", name: "Book marker property", desc: "The frontmatter property that marks a note as a book." },
  { key: "markerValue", name: "Book marker value", desc: "The value that property must have." },
  { key: "cover", name: "Cover", desc: "Property holding the cover image." },
  { key: "attachments", name: "Attachments", desc: "Property listing the book files attached to a note." },
  { key: "readState", name: "Read state", desc: "Property holding unread / reading / finished." },
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
    this.addCatalogSection(containerEl);
    this.addPropertiesSection(containerEl);
    this.addAnnotationTypesSection(containerEl);
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
        "Useful on mobile, where two outline tabs crowd the sidebar. Obsidian's core plugins cannot be " +
          "disabled by a plugin, so this closes its outline pane once when the vault opens — reopening it " +
          "during a session will stick.",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.panes.hideNativeOutline).onChange((value) => {
          this.host.settings.panes.hideNativeOutline = value;
          this.save();
        }),
      );
  }

  // ------------------------------------------------------------- catalog

  private addCatalogSection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Catalog").setHeading();

    new Setting(containerEl)
      .setName("OPDS catalog address")
      .setDesc(
        "An OPDS 1.2 Atom feed to browse and download from. Catalog search is not built yet, so this is " +
          "recorded and not yet used. Downloads will land wherever this vault's own attachment settings put files.",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://example.org/opds")
          .setValue(this.host.settings.catalog.url)
          .onChange((value) => {
            this.host.settings.catalog.url = value.trim();
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
            // A rename has to carry the active choice with it, or the reader's
            // highlight mode would silently fall back to the first type.
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
