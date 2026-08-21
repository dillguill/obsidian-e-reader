import type { BasesAllOptions } from "obsidian";
import { Notice, Plugin } from "obsidian";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { READER_VIEW_TYPE, ReaderView } from "./reader/reader-view";
import { type Settings, DEFAULT_SETTINGS, mergeSettings } from "./settings/settings-model";

function libraryViewOptions(): BasesAllOptions[] {
  return [
    // Same keys the built-in Cards view uses, so an existing `.base` works
    // unchanged and these controls write back to the same fields.
    { key: "image", type: "property", displayName: "Image property", default: "note.cover" },
    {
      key: "imageFit",
      type: "dropdown",
      displayName: "Image fit",
      default: "cover",
      options: { cover: "Fill", contain: "Fit" },
    },
    {
      key: "imageAspectRatio",
      type: "slider",
      displayName: "Image aspect ratio",
      default: 1,
      min: 0.5,
      max: 2,
      step: 0.1,
      instant: true,
    },
    {
      key: "cardSize",
      type: "slider",
      displayName: "Card size",
      default: 200,
      min: 100,
      max: 400,
      step: 10,
      instant: true,
    },
    // This plugin's own additions.
    { key: "readStateProperty", type: "property", displayName: "Read state property" },
    { key: "progressProperty", type: "property", displayName: "Progress property" },
    {
      key: "progressDisplay",
      type: "dropdown",
      displayName: "Progress display",
      default: "bar",
      options: { bar: "Bar", percent: "Percent" },
    },
  ];
}

/**
 * Clean-unload requirement: Obsidian never calls anything on this class
 * other than onload/onunload, so any listener, interval, view type, or
 * command this plugin registers MUST be registered through one of the
 * `register*` helpers (registerEvent, registerInterval, registerDomEvent,
 * registerView, addCommand, etc.). Those are torn down automatically when
 * the plugin unloads. Never attach anything by hand (e.g. addEventListener
 * directly, setInterval directly) — onunload must leave nothing behind,
 * and it must not need to do any manual cleanup to achieve that.
 */
export default class EReaderPlugin extends Plugin {
  override settings: Settings = DEFAULT_SETTINGS;

  override async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());

    const registered = this.registerBasesView(LIBRARY_VIEW_TYPE, {
      name: "Library",
      icon: "library",
      factory: (controller, containerEl) => new LibraryView(controller, containerEl),
      options: libraryViewOptions,
    });
    if (!registered) {
      new Notice("E-Reader: could not register the library view — Bases is not enabled in this vault.");
    }

    this.registerView(READER_VIEW_TYPE, (leaf) => new ReaderView(leaf));
  }

  override onunload(): void {
    // Nothing to clean up: everything this plugin adds must be registered
    // via register* helpers above, which Obsidian tears down for us.
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
