import type { BasesAllOptions, WorkspaceLeaf } from "obsidian";
import { Notice, Plugin } from "obsidian";
import { ReaderEvents } from "./core/reader-events";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { READER_VIEW_TYPE, ReaderView } from "./reader/reader-view";
import { HIGHLIGHTS_VIEW_TYPE, HighlightsView } from "./sidebar/highlights-view";
import { OUTLINE_VIEW_TYPE, OutlineView } from "./sidebar/outline-view";
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
  /** The reader's own event channel, so sidebar panes can follow it without a workspace-wide event name. */
  private readonly readerEvents = new ReaderEvents();

  override async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());

    this.registerView(READER_VIEW_TYPE, (leaf) => new ReaderView(leaf, () => this.settings, this.readerEvents));
    this.registerView(HIGHLIGHTS_VIEW_TYPE, (leaf) => new HighlightsView(leaf));
    this.registerView(OUTLINE_VIEW_TYPE, (leaf) => new OutlineView(leaf, this.readerEvents));

    // Obsidian does not index unknown extensions, so .epub files are invisible
    // to the vault and to link resolution until a view claims them. Claiming
    // it also makes an EPUB open in the reader from the file explorer.
    this.registerExtensions(["epub"], READER_VIEW_TYPE);

    const registered = this.registerBasesView(LIBRARY_VIEW_TYPE, {
      name: "Library",
      icon: "library",
      factory: (controller, containerEl) => new LibraryView(controller, containerEl),
      options: libraryViewOptions,
    });
    if (!registered) {
      new Notice("E-Reader: could not register the library view — Bases is not enabled in this vault.");
    }

    this.addCommand({
      id: "open-highlights",
      name: "Open highlights",
      callback: () => void this.revealPane(HIGHLIGHTS_VIEW_TYPE),
    });

    this.addCommand({
      id: "open-outline",
      name: "Open book outline",
      callback: () => void this.revealPane(OUTLINE_VIEW_TYPE),
    });

    // Obsidian's own Properties pane needs no registration here: the reader
    // reports the book note as its active file (see reader/reader-view.ts),
    // which is the only thing that pane follows. Its Outline pane cannot be
    // reused the same way — see sidebar/outline-view.ts for why.
    this.addCommand({
      id: "highlight-selection",
      name: "Highlight selection",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(ReaderView);
        const selection = view?.selection() ?? null;
        if (!view || !selection) return false;
        if (!checking) {
          const type = this.settings.annotationTypes[0] ?? "highlight";
          void view.createEntry(type, selection);
        }
        return true;
      },
    });

    this.addCommand({
      id: "add-bookmark",
      name: "Add bookmark at the current position",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(ReaderView);
        if (!view) return false;
        if (!checking) void view.createEntry("bookmark", null);
        return true;
      },
    });
  }

  /** Opens one of this plugin's panes in the right sidebar, reusing an existing one. */
  private async revealPane(viewType: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(viewType);
    const leaf: WorkspaceLeaf | null = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (existing.length === 0) await leaf.setViewState({ type: viewType, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  override onunload(): void {
    // Nothing to clean up: everything this plugin adds must be registered
    // via register* helpers above, which Obsidian tears down for us.
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
