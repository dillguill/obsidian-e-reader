import type { BasesAllOptions, WorkspaceLeaf } from "obsidian";
import { FuzzySuggestModal, Notice, Plugin, TFile } from "obsidian";
import { ReaderEvents } from "./core/reader-events";
import { BookImporter, IMPORTABLE_EXTENSIONS, type ImportResult, type ImportSource } from "./import/importer";
import { isInFolder } from "./import/plan";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { readPdfMetadata } from "./reader/pdf/adapter";
import { READER_VIEW_TYPE, ReaderView } from "./reader/reader-view";
import { HIGHLIGHTS_VIEW_TYPE, HighlightsView } from "./sidebar/highlights-view";
import { OUTLINE_VIEW_TYPE, OutlineView } from "./sidebar/outline-view";
import { EReaderSettingTab, type SettingsHost } from "./settings/settings-tab";
import { type Settings, DEFAULT_SETTINGS, SETTINGS_VERSION, mergeSettings } from "./settings/settings-model";

/**
 * How long a new file in the inbox must sit unchanged before it is imported.
 * A sync client or a browser writes a download in pieces, and the vault
 * reports the file as created at the first of them.
 */
const INBOX_SETTLE_MS = 2000;

/** Obsidian's own outline pane. Closed once at startup when the reader asks for it. */
const NATIVE_OUTLINE_VIEW_TYPE = "outline";

function libraryViewOptions(settings: Settings): BasesAllOptions[] {
  return [
    // Same keys the built-in Cards view uses, so an existing `.base` works
    // unchanged and these controls write back to the same fields.
    { key: "image", type: "property", displayName: "Image property", default: `note.${settings.properties.cover}` },
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
    // Defaulted to whatever the reader writes, so the overlays appear on a
    // plain `.base` instead of only after the reader binds it by hand. This
    // one binding drives both the progress bar and the badge derived from it.
    {
      key: "progressProperty",
      type: "property",
      displayName: "Progress property",
      default: `note.${settings.properties.progress}`,
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
export default class EReaderPlugin extends Plugin implements SettingsHost {
  override settings: Settings = DEFAULT_SETTINGS;
  /** The reader's own event channel, so sidebar panes can follow it without a workspace-wide event name. */
  private readonly readerEvents = new ReaderEvents();
  private readonly importer = new BookImporter(this.app, () => this.settings, readPdfMetadata);
  /** Inbox files waiting to settle, by path. */
  private readonly inboxTimers = new Map<string, number>();
  /** Inbox files already reported as duplicates this session, so a rescan does not report them again. */
  private readonly inboxSkipped = new Set<string>();

  override async onload(): Promise<void> {
    try {
      await this.setUp();
    } catch (error) {
      // Obsidian reports a failed onload as a bare "failed to load plugin",
      // and mobile has no console to look in. Surface the real message on the
      // device, then rethrow so the failure stays a failure rather than a
      // half-loaded plugin pretending otherwise.
      new Notice(`E-Reader failed to load: ${String(error)}`, 15000);
      throw error;
    }
  }

  private async setUp(): Promise<void> {
    const saved: unknown = await this.loadData();
    this.settings = mergeSettings(saved);
    // Persist a migration straight away rather than waiting for whatever
    // incidental save happens to come next, so `data.json` and the running
    // settings never disagree about which properties the reader writes.
    const savedVersion =
      typeof saved === "object" && saved !== null ? (saved as { version?: unknown }).version : undefined;
    if (savedVersion !== SETTINGS_VERSION) await this.saveSettings();

    this.addSettingTab(new EReaderSettingTab(this.app, this));

    this.registerView(
      READER_VIEW_TYPE,
      (leaf) => new ReaderView(leaf, () => this.settings, () => void this.saveSettings(), this.readerEvents),
    );
    // Both panes are registered whatever the settings say: `registerView` has
    // no public counterpart to undo it, so the toggles gate the commands and
    // detach open leaves instead (see applyPaneSettings).
    this.registerView(HIGHLIGHTS_VIEW_TYPE, (leaf) => new HighlightsView(leaf));
    this.registerView(OUTLINE_VIEW_TYPE, (leaf) => new OutlineView(leaf, this.readerEvents));

    // Obsidian does not index unknown extensions, so .epub files are invisible
    // to the vault and to link resolution until a view claims them. Claiming
    // it also makes an EPUB open in the reader from the file explorer. The
    // reader can hand EPUBs back to Obsidian instead — and because
    // `registerExtensions` has no public un-register, that choice can only be
    // honoured at load time, which is what the setting's description says.
    if (this.settings.readers.epub === "plugin") {
      this.registerExtensions(["epub"], READER_VIEW_TYPE);
    }

    // Bases is an optional integration: the reader and the sidebars stand on
    // their own without it. `registerBasesView` arrived in 1.10.0 and is
    // absent on builds without Bases, so this is feature detection rather
    // than a version check — calling a missing method here would take the
    // whole plugin down with it.
    if (typeof this.registerBasesView !== "function") {
      console.info("[e-reader] this Obsidian build has no Bases API; the library view is unavailable.");
    } else {
      const registered = this.registerBasesView(LIBRARY_VIEW_TYPE, {
        name: "Library",
        icon: "library",
        factory: (controller, containerEl) =>
          new LibraryView(controller, containerEl, () => this.settings, (source) => this.importBook(source)),
        options: () => libraryViewOptions(this.settings),
      });
      if (!registered) {
        new Notice("E-Reader: could not register the library view — Bases is not enabled in this vault.");
      }
    }

    this.addCommand({
      id: "open-highlights",
      name: "Open highlights",
      checkCallback: (checking) => {
        if (!this.settings.panes.highlights) return false;
        if (!checking) void this.revealPane(HIGHLIGHTS_VIEW_TYPE);
        return true;
      },
    });

    this.addCommand({
      id: "open-outline",
      name: "Open outline",
      checkCallback: (checking) => {
        if (!this.settings.panes.outline) return false;
        if (!checking) void this.revealPane(OUTLINE_VIEW_TYPE);
        return true;
      },
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
          void view.createEntry(this.activeHighlightType(), selection);
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

    // No default hotkeys: the arrow keys already turn pages inside the reader,
    // and these are here so a page turn or zoom can be bound to anything else.
    const readerCommand = (id: string, name: string, run: (view: ReaderView) => Promise<void>): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(ReaderView);
          if (!view) return false;
          if (!checking) void run(view);
          return true;
        },
      });
    };
    readerCommand("next-page", "Next page", (view) => view.turnPage(1));
    readerCommand("previous-page", "Previous page", (view) => view.turnPage(-1));
    readerCommand("zoom-in", "Zoom in", (view) => view.zoom(1));
    readerCommand("zoom-out", "Zoom out", (view) => view.zoom(-1));

    this.addCommand({
      id: "import-book",
      name: "Import a book from the vault",
      callback: () => new ImportSuggestModal(this, (file) => void this.importBook({ kind: "vault", file })).open(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !IMPORTABLE_EXTENSIONS.has(file.extension)) return;
        if (this.attachedPaths().has(file.path)) return;
        menu.addItem((item) =>
          item
            .setTitle("Import as book")
            .setIcon("book-plus")
            .onClick(() => void this.importBook({ kind: "vault", file })),
        );
      }),
    );

    // Closing Obsidian's outline is a single action taken when the vault
    // opens, never a watcher that keeps re-closing it: there is no supported
    // way to disable a core plugin (`app.internalPlugins` is not public API),
    // and re-applying it behind the reader's back would be worse than the
    // honest limitation stated in the setting's description.
    //
    // Saving the layout afterwards is the part that makes this stick. The
    // core Outline plugin does not re-create its leaf on load — every
    // `initLeaf` call sits behind `onUserEnable` — so the tab comes back from
    // the SAVED WORKSPACE, and detaching a leaf without persisting the result
    // means the next app open restores it again. That is why this appeared to
    // do nothing.
    this.app.workspace.onLayoutReady(() => {
      // A saved workspace can restore a pane the reader has since switched
      // off, so the toggles are applied here too, not only when they change.
      this.applyPaneSettings();
      if (this.settings.panes.hideNativeOutline) {
        this.app.workspace.detachLeavesOfType(NATIVE_OUTLINE_VIEW_TYPE);
      }
      void this.app.workspace.requestSaveLayout();

      // Registered only once the vault has loaded: before that, every
      // existing file is reported as created.
      this.registerEvent(this.app.vault.on("create", (file) => this.onInboxCandidate(file)));
      this.registerEvent(this.app.vault.on("modify", (file) => this.onInboxCandidate(file)));
      this.scanInbox();
    });
  }

  /** Imports whatever is already sitting in the inbox. Called at startup and when the inbox setting changes. */
  scanInbox(): void {
    const inbox = this.settings.import.inboxFolder;
    if (inbox === "") return;
    for (const file of this.app.vault.getFiles()) this.onInboxCandidate(file);
  }

  /** Schedules an inbox file for import once it has stopped changing. */
  private onInboxCandidate(file: unknown): void {
    if (!(file instanceof TFile) || !IMPORTABLE_EXTENSIONS.has(file.extension)) return;
    if (!isInFolder(file.path, this.settings.import.inboxFolder) || this.importer.wrote(file.path)) return;
    if (this.inboxSkipped.has(file.path)) return;
    const pending = this.inboxTimers.get(file.path);
    if (pending !== undefined) window.clearTimeout(pending);
    const timer = window.setTimeout(() => {
      this.inboxTimers.delete(file.path);
      // It may have been moved or deleted while settling.
      if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
      void this.importBook({ kind: "vault", file }).then((result) => {
        if (result?.status === "duplicate") this.inboxSkipped.add(file.path);
      });
    }, INBOX_SETTLE_MS);
    this.inboxTimers.set(file.path, timer);
    this.registerInterval(timer);
  }

  /** Runs an import and reports how it went. */
  async importBook(source: ImportSource): Promise<ImportResult | null> {
    const name = source.kind === "vault" ? source.file.name : source.name;
    try {
      const result = await this.importer.import(source);
      if (result.status === "imported") new Notice(`Imported “${result.title}”.`);
      else if (result.status === "duplicate") {
        new Notice(`“${result.title}” is already in your library, as ${result.existing.basename}. Nothing was changed.`, 8000);
      } else new Notice(`${name} is not an EPUB or PDF.`);
      return result;
    } catch (error) {
      console.error("[e-reader] import failed", error);
      new Notice(`Could not import ${name}: ${String(error)}. Nothing was changed.`, 10000);
      return null;
    }
  }

  /** The type a highlight is written as. Falls back when every type has been removed. */
  private activeHighlightType(): string {
    const active = this.settings.reader.activeAnnotationType;
    if (active !== "") return active;
    return this.settings.annotationTypes[0]?.name ?? "highlight";
  }

  /** Paths of every file a book note already links. */
  attachedPaths(): Set<string> {
    return this.importer.attachedPaths();
  }

  /** Closes any pane the reader has just switched off. Called from the settings tab. */
  applyPaneSettings(): void {
    if (!this.settings.panes.outline) this.app.workspace.detachLeavesOfType(OUTLINE_VIEW_TYPE);
    if (!this.settings.panes.highlights) this.app.workspace.detachLeavesOfType(HIGHLIGHTS_VIEW_TYPE);
    if (this.settings.panes.hideNativeOutline) this.app.workspace.detachLeavesOfType(NATIVE_OUTLINE_VIEW_TYPE);
    void this.app.workspace.requestSaveLayout();
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

/** Picks an EPUB or PDF in the vault that is not yet a book. */
class ImportSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    private readonly plugin: EReaderPlugin,
    private readonly onChoose: (file: TFile) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder("Choose an EPUB or PDF to import");
  }

  getItems(): TFile[] {
    const attached = this.plugin.attachedPaths();
    return this.app.vault
      .getFiles()
      .filter((file) => IMPORTABLE_EXTENSIONS.has(file.extension) && !attached.has(file.path));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChoose(file);
  }
}
