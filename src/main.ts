import type { BasesAllOptions, WorkspaceLeaf } from "obsidian";
import { FuzzySuggestModal, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { findBookForEntry, highlightOfNote } from "./annotations/links";
import { mergeBookInto, renameTypeInBook } from "./annotations/store";
import { resolveBookAttachment } from "./core/attachment";
import { isBookNote } from "./core/book-note";
import { applyStatus, hasStatus, statusProperty } from "./core/status";
import { ReaderEvents } from "./core/reader-events";
import { RESERVED_ENTRY_TYPE } from "./core/types";
import { BookImporter, IMPORTABLE_EXTENSIONS, type ImportResult, type ImportSource } from "./import/importer";
import { type WishlistPick, chooseBookFile, searchForWishlist } from "./import/modals";
import { readEpubImages, readEpubMetadata } from "./import/epub-metadata";
import type { BookCover } from "./import/metadata";
import { coverChoices, coverImageUrl, fetchCover, findBook } from "./import/open-library";
import { type CoverOption, type DetailOption, pickCover, pickDetails } from "./import/review-modals";
import { detailRows, groupDuplicates, isInFolder, keepDetails } from "./import/plan";
import { DuplicatesModal } from "./library/duplicates-modal";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./library/library-view";
import { readPdfMetadata } from "./reader/pdf/adapter";
import { READER_VIEW_TYPE, ReaderView } from "./reader/reader-view";
import { activeReaderFor, revealReader } from "./sidebar/active-reader";
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
  /** Inbox files already reported or declined this session, so a rescan does not raise them again. */
  private readonly inboxSkipped = new Set<string>();
  /** Inbox files that have settled, gathered so files arriving together are handled together. */
  private readonly settled = new Map<string, TFile>();
  private settledTimer: number | null = null;

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
      (leaf) =>
        new ReaderView(
          leaf,
          () => this.settings,
          () => void this.saveSettings(),
          this.readerEvents,
          (note) => this.attachFile(note),
          () => void this.revealPane(OUTLINE_VIEW_TYPE),
          () => void this.revealPane(HIGHLIGHTS_VIEW_TYPE),
        ),
    );
    // Both panes are registered whatever the settings say: `registerView` has
    // no public counterpart to undo it, so the toggles gate the commands and
    // detach open leaves instead (see applyPaneSettings).
    this.registerView(HIGHLIGHTS_VIEW_TYPE, (leaf) => new HighlightsView(leaf, () => this.settings));
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
          new LibraryView(
            controller,
            containerEl,
            () => this.settings,
            (source) => this.importBook(source),
            (note) => this.attachFile(note),
            {
              changeCover: (note) => void this.changeCover(note),
              updateDetails: (note) => this.updateDetails(note),
            },
          ),
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
    readerCommand("next-chapter", "Next chapter", (view) => view.goToChapter(1));
    readerCommand("previous-chapter", "Previous chapter", (view) => view.goToChapter(-1));
    readerCommand("zoom-in", "Zoom in", (view) => view.zoom(1));
    readerCommand("zoom-out", "Zoom out", (view) => view.zoom(-1));
    readerCommand("toggle-toolbar", "Show or hide the reader toolbar", (view) => Promise.resolve(view.toggleChrome()));

    this.addCommand({
      id: "import-book",
      name: "Import a book from the vault",
      callback: () => new ImportSuggestModal(this, (file) => void this.importBook({ kind: "vault", file })).open(),
    });

    // The links each highlight carries (annotations/highlight-notes.ts,
    // readerUrl): obsidian://e-reader?id=<entry> opens the book in the reader
    // at that highlight. Links written by 0.3.7 betas also name the book
    // note (`file=`), which is used when it still resolves.
    this.registerObsidianProtocolHandler("e-reader", (params) => void this.openHighlight(params["file"], params["id"]));

    this.addCommand({
      id: "open-highlight-in-book",
      name: "Open this note's highlight in the book",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const found = file ? highlightOfNote(this.app, file, this.settings.highlights) : null;
        if (!found) return false;
        if (!checking) void this.openHighlight(found.book.path, found.id);
        return true;
      },
    });
    this.addCommand({
      id: "rename-highlight-type",
      name: "Rename a highlight type",
      callback: () => new HighlightTypeSuggest(this, (from) => this.renameHighlightType(from, () => undefined)).open(),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const found = highlightOfNote(this.app, file, this.settings.highlights);
        if (!found) return;
        menu.addItem((item) =>
          item
            .setTitle("Open in book")
            .setIcon("book-open")
            .onClick(() => void this.openHighlight(found.book.path, found.id)),
        );
      }),
    );

    this.addCommand({
      id: "find-duplicate-books",
      name: "Find duplicate books",
      callback: () => this.findDuplicates(),
    });

    this.addCommand({
      id: "add-to-wishlist",
      name: "Add a book to the wishlist",
      callback: () => searchForWishlist(this.app, (pick) => void this.addToWishlist(pick)),
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
      void this.migrateReadLater().then(() => this.migrateWishlist());
    });
  }

  /**
   * Moves read later from the checkbox it used to be into the status list,
   * once. The marker stays saved until every note is done, so a vault closed
   * partway through finishes the next time it opens.
   */
  private async migrateReadLater(): Promise<void> {
    const legacy = this.settings.pendingReadLaterMigration;
    if (legacy === undefined) return;
    const { status } = this.settings;
    let moved = 0;
    for (const note of this.bookNotes()) {
      if (this.app.metadataCache.getFileCache(note)?.frontmatter?.[legacy] === undefined) continue;
      await this.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
        const wasOn = frontmatter[legacy] === true;
        delete frontmatter[legacy];
        if (wasOn) {
          applyStatus(frontmatter, status, status.readLater, true);
          moved++;
        }
      });
    }
    delete this.settings.pendingReadLaterMigration;
    await this.saveSettings();
    if (moved > 0) {
      const where = status.useTags ? "tags" : `“${status.property}”`;
      new Notice(`E-Reader: read later is now a status in ${where}. Moved ${moved} ${moved === 1 ? "book" : "books"}.`, 8000);
    }
  }

  /** Gives the wishlist status, once, to book notes that were wishlist books before it existed: those with no file. */
  private async migrateWishlist(): Promise<void> {
    if (!this.settings.pendingWishlistMigration) return;
    const { status, properties } = this.settings;
    for (const note of this.bookNotes()) {
      if (resolveBookAttachment(this.app, note, properties.attachments) !== null) continue;
      if (hasStatus(this.app.metadataCache.getFileCache(note)?.frontmatter?.[statusProperty(status)], status.wishlist)) continue;
      await this.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
        applyStatus(frontmatter, status, status.wishlist, true);
      });
    }
    delete this.settings.pendingWishlistMigration;
    await this.saveSettings();
  }

  /** Imports whatever is already sitting in the inbox. Called at startup and when the inbox setting changes. */
  scanInbox(): void {
    const inbox = this.settings.import.inboxFolder;
    if (inbox === "") return;
    // A book's own file can live in the inbox, when the inbox is also where
    // book files are kept. Those are the library, not new arrivals, and
    // reading them all again at every start can take a phone down.
    const attached = this.importer.attachedPaths();
    for (const file of this.app.vault.getFiles()) {
      if (!attached.has(file.path)) this.onInboxCandidate(file);
    }
  }

  /** Schedules an inbox file for import once it has stopped changing. */
  private onInboxCandidate(file: unknown): void {
    if (!(file instanceof TFile) || !IMPORTABLE_EXTENSIONS.has(file.extension)) return;
    if (!isInFolder(file.path, this.settings.import.inboxFolder) || this.importer.wrote(file.path)) return;
    if (this.inboxSkipped.has(file.path)) return;
    if (file.extension === "pdf" && this.settings.import.ignoredPdfs.includes(file.path)) return;
    const pending = this.inboxTimers.get(file.path);
    if (pending !== undefined) window.clearTimeout(pending);
    const timer = window.setTimeout(() => {
      this.inboxTimers.delete(file.path);
      // It may have been moved or deleted while settling.
      if (this.app.vault.getAbstractFileByPath(file.path) !== file) return;
      this.queueSettled(file);
    }, INBOX_SETTLE_MS);
    this.inboxTimers.set(file.path, timer);
    this.registerInterval(timer);
  }

  /**
   * Gathers settled inbox files, then imports the EPUBs and asks about the
   * PDFs. An EPUB is a book; a PDF is as likely to be a paper or a receipt,
   * so nothing happens to one until the reader says so.
   */
  private queueSettled(file: TFile): void {
    if (file.extension === "pdf" && this.settings.import.ignoredPdfs.includes(file.path)) return;
    this.settled.set(file.path, file);
    if (this.settledTimer !== null) window.clearTimeout(this.settledTimer);
    this.settledTimer = window.setTimeout(() => {
      this.settledTimer = null;
      const attached = this.importer.attachedPaths();
      const files = [...this.settled.values()].filter(
        (f) => this.app.vault.getAbstractFileByPath(f.path) === f && !attached.has(f.path),
      );
      this.settled.clear();
      for (const f of files) this.inboxSkipped.add(f.path);
      const epubs = files.filter((f) => f.extension === "epub");
      const pdfs = files.filter((f) => f.extension === "pdf");
      if (epubs.length > 0) void this.importInbox(epubs);
      if (pdfs.length === 0) return;
      new InboxPdfModal(this, pdfs, (chosen, ignored) => {
        if (ignored.length > 0) {
          this.settings.import.ignoredPdfs.push(...ignored.map((f) => f.path));
          void this.saveSettings();
        }
        if (chosen.length > 0) void this.importInbox(chosen);
      }).open();
    }, INBOX_SETTLE_MS);
    this.registerInterval(this.settledTimer);
  }

  /** Imports a batch from the inbox and reports it in one notice rather than one per file. */
  private async importInbox(files: TFile[]): Promise<void> {
    const imported: string[] = [];
    const duplicates: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        const result = await this.importer.import({ kind: "vault", file });
        if (result.status === "imported") imported.push(result.title);
        else if (result.status === "duplicate") {
          duplicates.push(result.title);
          this.inboxSkipped.add(file.path);
        }
      } catch (error) {
        console.error(`[e-reader] could not import ${file.path}`, error);
        failed.push(file.name);
        this.inboxSkipped.add(file.path);
      }
    }
    const lines: string[] = [];
    if (imported.length === 1) lines.push(`Imported “${imported[0]}”.`);
    else if (imported.length > 1) lines.push(`Imported ${imported.length} books.`);
    if (duplicates.length > 0) {
      lines.push(`${duplicates.length === 1 ? `“${duplicates[0]}” is` : `${duplicates.length} books are`} already in your library.`);
    }
    if (failed.length > 0) {
      lines.push(`Could not import ${failed.length === 1 ? failed[0] : `${failed.length} files`}; the developer console has the details.`);
    }
    if (lines.length > 0) new Notice(lines.join("\n"), failed.length > 0 ? 10000 : 5000);
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

  /**
   * Opens a book note in the reader, reusing a tab already showing it, and
   * moves to one of its highlights. Without a usable path the book is found
   * from the highlight's id.
   */
  private async openHighlight(path: string | undefined, id: string | undefined): Promise<void> {
    const named = path ? this.app.vault.getAbstractFileByPath(path) : null;
    const note = named instanceof TFile ? named : id ? findBookForEntry(this.app, id, this.settings.highlights) : null;
    if (!(note instanceof TFile)) {
      new Notice("E-Reader: that book's note could not be found.");
      return;
    }
    let reader = activeReaderFor(this.app, note);
    if (!reader) {
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: READER_VIEW_TYPE, state: { file: note.path }, active: true });
      reader = leaf.view instanceof ReaderView ? leaf.view : null;
    }
    if (!reader) return;
    revealReader(this.app, reader);
    if (id) await reader.goToEntry(id);
  }

  /** Lists the books in the library more than once, to merge each into one note. */
  private findDuplicates(): void {
    const { attachments } = this.settings.properties;
    const books = this.importer.bookNotes().map((note) => ({
      note,
      hasFile: resolveBookAttachment(this.app, note, attachments) !== null,
    }));
    const groups = groupDuplicates(books, (book) => this.importer.identityOf(book.note));
    new DuplicatesModal(this.app, groups, async (keep, others) => {
      try {
        for (const [index, other] of others.entries()) {
          // The next merge locates highlights from the metadata cache, which
          // catches up with the last write a moment after it lands.
          if (index > 0) await this.cacheCaughtUp(keep);
          await mergeBookInto(this.app, other, keep, this.settings);
        }
        new Notice(`Merged into “${keep.basename}”. The other ${others.length === 1 ? "note is" : "notes are"} in the trash.`);
        return true;
      } catch (error) {
        console.error("[e-reader] could not merge duplicate books", error);
        new Notice(`Could not merge into “${keep.basename}”: ${String(error)}`, 10000);
        return false;
      }
    }).open();
  }

  /** Resolves once the metadata cache has re-read `file`, or after two seconds if it already had. */
  private cacheCaughtUp(file: TFile): Promise<void> {
    return new Promise((resolve) => {
      const ref = this.app.metadataCache.on("changed", (changed) => {
        if (changed.path !== file.path) return;
        finish();
      });
      const timer = window.setTimeout(() => finish(), 2000);
      const finish = (): void => {
        window.clearTimeout(timer);
        this.app.metadataCache.offref(ref);
        resolve();
      };
    });
  }

  /** Every book note in the vault. */
  private bookNotes(): TFile[] {
    const { marker, markerValue } = this.settings.properties;
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => isBookNote(this.app.metadataCache.getFileCache(file)?.frontmatter, marker, markerValue));
  }

  /** Asks for a new name for highlight type `from`, then renames it in settings and in every book. */
  renameHighlightType(from: string, onDone: () => void): void {
    new RenameTypeModal(this, from, (to) => {
      void this.renameTypeEverywhere(from, to).then(onDone);
    }).open();
  }

  private async renameTypeEverywhere(from: string, to: string): Promise<void> {
    const type = this.settings.annotationTypes.find((candidate) => candidate.name === from);
    const merged = this.settings.annotationTypes.some((candidate) => candidate.name === to);
    if (type && !merged) type.name = to;
    // Renaming onto an existing type merges the two; the target keeps its colour.
    if (type && merged) this.settings.annotationTypes = this.settings.annotationTypes.filter((candidate) => candidate !== type);
    if (this.settings.reader.activeAnnotationType === from) this.settings.reader.activeAnnotationType = to;
    await this.saveSettings();
    let count = 0;
    const failed: string[] = [];
    for (const book of this.bookNotes()) {
      try {
        count += await renameTypeInBook(this.app, book, from, to, this.settings);
      } catch (error) {
        console.error(`[e-reader] could not rename highlight types in ${book.path}`, error);
        failed.push(book.basename);
      }
    }
    const lines = [`Renamed “${from}” to “${to}” on ${count} highlight${count === 1 ? "" : "s"}.`];
    if (failed.length > 0) lines.push(`Could not update ${failed.length === 1 ? `“${failed[0]}”` : `${failed.length} books`}; the developer console has the details.`);
    new Notice(lines.join("\n"), failed.length > 0 ? 10000 : 5000);
  }

  /** Saves a book you do not have yet, with its cover when Open Library has one. */
  /** Adds a book from an Open Library search, after asking which cover and which details to keep. */
  async addToWishlist(pick: WishlistPick): Promise<void> {
    const { title } = pick.meta;
    const covers = coverChoices(pick.coverId, pick.workKey).then((ids) => ids.map(remoteCover));
    const coverPick = await pickCover(this.app, covers, { title, skipLabel: "No cover", oldCover: null });
    if (coverPick === null) return;
    const rows = detailRows(pick.meta);
    const chosen = rows.length === 0 ? new Set<string>() : await pickDetails(this.app, rows, { title, confirmLabel: "Add to wishlist" });
    if (chosen === null) return;
    const { choice } = coverPick;
    const meta = keepDetails({ ...pick.meta, cover: choice.kind === "image" ? choice.cover : undefined }, chosen);
    try {
      const result = await this.importer.addToWishlist(meta, choice.kind === "vault" ? choice.file : null);
      if (result.status === "imported") new Notice(`Added “${result.title}” to your wishlist.`);
      else if (result.status === "duplicate") {
        new Notice(`“${result.title}” is already in your library, as ${result.existing.basename}. Nothing was changed.`, 8000);
      }
    } catch (error) {
      console.error("[e-reader] could not add to the wishlist", error);
      new Notice(`Could not add “${title}”: ${String(error)}. Nothing was changed.`, 10000);
    }
  }

  /** Offers the book file's own cover and Open Library's, and saves the one chosen. */
  private async changeCover(note: TFile): Promise<void> {
    const identity = this.noteMetadata(note);
    const urls: string[] = [];
    const options = (async (): Promise<CoverOption[]> => {
      const found: CoverOption[] = [];
      const file = resolveBookAttachment(this.app, note, this.settings.properties.attachments);
      const offer = (cover: BookCover, label: string): void => {
        const url = URL.createObjectURL(new Blob([cover.data]));
        urls.push(url);
        found.push({ src: url, label, load: async () => cover });
      };
      try {
        if (file?.extension === "epub") {
          const data = await this.app.vault.readBinary(file);
          const { cover } = await readEpubMetadata(data, note.basename);
          if (cover) offer(cover, "The book's own cover");
          for (const image of await readEpubImages(data)) offer(image, "A picture inside the book");
        } else if (file?.extension === "pdf") {
          const { cover } = await readPdfMetadata(await this.app.vault.readBinary(file));
          if (cover) offer({ data: cover, extension: "jpg" }, "The first page");
        }
      } catch (error) {
        console.debug("[e-reader] could not read covers from the book file", error);
      }
      const match = await findBook(identity);
      const ids = await coverChoices(match?.coverId ?? null, match?.workKey ?? null);
      return [...found, ...ids.map(remoteCover)];
    })();
    const pick = await pickCover(this.app, options, {
      title: identity.title,
      skipLabel: "Remove cover",
      oldCover: this.importer.coverFileOf(note),
    });
    for (const url of urls) URL.revokeObjectURL(url);
    if (pick === null) return;
    const { choice } = pick;
    try {
      await this.importer.setCover(note, choice.kind === "image" ? choice.cover : choice.kind === "vault" ? choice.file : null, pick.removeOld);
    } catch (error) {
      console.error("[e-reader] could not change the cover", error);
      new Notice(`Could not change the cover: ${String(error)}`, 10000);
    }
  }

  /** Searches Open Library for the book, then writes the details chosen over what the note says. */
  private updateDetails(note: TFile): void {
    const identity = this.noteMetadata(note);
    const query = [identity.title, identity.authors[0]].filter((part) => part).join(" ");
    searchForWishlist(
      this.app,
      (pick) => {
        void (async () => {
          const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
          const rows: DetailOption[] = [];
          for (const row of detailRows(pick.meta)) {
            const now: unknown = frontmatter[row.property];
            const current = Array.isArray(now) ? now.join(", ") : now === undefined || now === null || now === "" ? undefined : String(now);
            if (current === row.display) continue;
            rows.push(current === undefined ? row : { ...row, current });
          }
          const chosen = await pickDetails(this.app, rows, { title: identity.title, confirmLabel: "Update" });
          if (chosen === null || chosen.size === 0) return;
          try {
            await this.importer.setDetails(note, keepDetails(pick.meta, chosen));
          } catch (error) {
            console.error("[e-reader] could not update details", error);
            new Notice(`Could not update the details: ${String(error)}`, 10000);
          }
        })();
      },
      query,
    );
  }

  /** The title, first author and ISBN a book note gives, for looking it up. */
  private noteMetadata(note: TFile): { title: string; authors: string[]; isbn?: string } {
    const fm = this.app.metadataCache.getFileCache(note)?.frontmatter ?? {};
    const title = typeof fm["title"] === "string" && fm["title"].trim() !== "" ? fm["title"] : note.basename;
    const author: unknown = fm["author"];
    const first: unknown = Array.isArray(author) ? author[0] : author;
    const isbn: unknown = fm["isbn"];
    return {
      title,
      authors: typeof first === "string" ? [first.replace(/^\[\[|\]\]$/g, "")] : [],
      ...(typeof isbn === "string" || typeof isbn === "number" ? { isbn: String(isbn) } : {}),
    };
  }


  /** Asks for a book's file and attaches it. Resolves true once the book has its file. */
  async attachFile(note: TFile): Promise<boolean> {
    const source = await chooseBookFile(this.app, () => {
      const attached = this.attachedPaths();
      return this.app.vault.getFiles().filter((file) => !attached.has(file.path));
    });
    if (!source) return false;
    const name = source.kind === "vault" ? source.file.name : source.name;
    try {
      const result = await this.importer.attach(note, source);
      if (result.status === "attached") {
        new Notice(`Added ${result.file.name} to “${note.basename}”.`);
        return true;
      }
      if (result.status === "in-use") new Notice(`${name} already belongs to “${result.existing.basename}”. Nothing was changed.`, 8000);
      else new Notice(`${name} is not an EPUB or PDF.`);
      return false;
    } catch (error) {
      console.error("[e-reader] could not attach a file", error);
      new Notice(`Could not add ${name}: ${String(error)}. Nothing was changed.`, 10000);
      return false;
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
  applyFocusMode(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
      if (leaf.view instanceof ReaderView) leaf.view.applyFocusMode();
    }
  }

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

/** An Open Library cover to choose from: a thumbnail shown, the large image saved. */
function remoteCover(id: number): CoverOption {
  return { src: coverImageUrl(id, "M"), label: "Open Library cover", load: () => fetchCover(coverImageUrl(id, "L")) };
}

const PDF_PAGE_SIZE = 50;

/** Asks which of the PDFs that arrived in the inbox are books. */
class InboxPdfModal extends Modal {
  private readonly chosen = new Set<TFile>();
  private settled = false;

  constructor(
    plugin: EReaderPlugin,
    private readonly files: TFile[],
    private readonly onDone: (chosen: TFile[], ignored: TFile[]) => void,
  ) {
    super(plugin.app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(this.files.length === 1 ? "Import this PDF as a book?" : `Import these ${this.files.length} PDFs as books?`);
    contentEl.createEl("p", {
      text:
        "PDFs in your inbox are only imported when you say so. Tick the ones that are books; " +
        "the rest are not asked about again. Add one later with “Import as book” in its file menu.",
      cls: "setting-item-description",
    });
    const list = contentEl.createDiv();
    const footer = contentEl.createDiv();
    // Hundreds of rows at once can take a phone down, so they come a page at a time.
    let shown = 0;
    const more = new Setting(footer).addButton((button) =>
      button.setButtonText("Show more").onClick(() => showPage()),
    );
    const showPage = (): void => {
      const end = Math.min(this.files.length, shown + PDF_PAGE_SIZE);
      for (; shown < end; shown++) {
        const file = this.files[shown];
        if (file) this.renderRow(list, file);
      }
      more.settingEl.toggle(shown < this.files.length);
      more.setName(shown < this.files.length ? `Showing ${shown} of ${this.files.length}` : "");
    };
    showPage();
    new Setting(footer).addButton((button) =>
      button
        .setButtonText("Import")
        .setCta()
        .onClick(() => this.finish()),
    );
  }

  private renderRow(list: HTMLElement, file: TFile): void {
    new Setting(list)
      .setName(file.basename)
      .setDesc(file.parent?.path ?? "")
      .addToggle((toggle) =>
        toggle.setValue(false).onChange((on) => {
          if (on) this.chosen.add(file);
          else this.chosen.delete(file);
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    // Closing counts as an answer too: whatever is ticked is imported and
    // the rest are not asked about again, so the same list cannot come
    // back at every start.
    if (!this.settled) this.finish();
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.onDone([...this.chosen], this.files.filter((file) => !this.chosen.has(file)));
    this.close();
  }
}

/** Picks one of the configured highlight types. */
class HighlightTypeSuggest extends FuzzySuggestModal<string> {
  constructor(
    private readonly plugin: EReaderPlugin,
    private readonly onChoose: (type: string) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder("Choose the highlight type to rename");
  }

  getItems(): string[] {
    return this.plugin.settings.annotationTypes.map((type) => type.name);
  }

  getItemText(type: string): string {
    return type;
  }

  onChooseItem(type: string): void {
    this.onChoose(type);
  }
}

/** Asks for a highlight type's new name. */
class RenameTypeModal extends Modal {
  constructor(
    plugin: EReaderPlugin,
    private readonly from: string,
    private readonly onRename: (to: string) => void,
  ) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.setTitle(`Rename “${this.from}”`);
    this.contentEl.createEl("p", {
      text: "Every highlight of this type is renamed too, in every book note and on exported highlight notes.",
      cls: "setting-item-description",
    });
    let value = this.from;
    const submit = (): void => {
      const to = value.trim();
      if (to === "" || to === this.from) return;
      if (to === RESERVED_ENTRY_TYPE) {
        new Notice(`E-Reader: "${RESERVED_ENTRY_TYPE}" is reserved for bookmarks.`);
        return;
      }
      this.close();
      this.onRename(to);
    };
    new Setting(this.contentEl).setName("New name").addText((text) => {
      text.setValue(this.from).onChange((next) => {
        value = next;
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
      });
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Rename").setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
