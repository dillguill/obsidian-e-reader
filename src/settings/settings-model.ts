// Plugin settings: reader-configurable frontmatter property names (FR-006),
// the annotation type set (FR-020a), which reader handles each format, which
// sidebar panes are on, where imported books go, and the reader preferences that
// have to survive closing a book. Property names default to kebab-case,
// matching the frontmatter keys the plugin itself writes. See
// specs/001-bases-ereader/data-model.md for the property-by-property
// rationale.
//
// Everything loaded from disk is merged FIELD BY FIELD against the defaults
// rather than accepted or rejected wholesale: a `data.json` that is partly
// from an older version, partly hand-edited, or partly corrupt still yields a
// complete, valid Settings object.

import { type StatusSettings, normalizeStatus } from "../core/status";
import { RESERVED_ENTRY_TYPE } from "../core/types";
import { type SpreadMode, isSpreadMode } from "../reader/spread";
import {
  type BookFont,
  type LineSpacing,
  type Margins,
  type ReadingTheme,
  isBookFont,
  isLineSpacing,
  isMargins,
  isReadingTheme,
} from "../reader/typography";
import { DEFAULT_PACE_EPUB_MS, DEFAULT_PACE_PDF_MS, clampPace } from "../reader/reading-time";
import { clampScale } from "../reader/zoom";

/**
 * The frontmatter keys this plugin reads and writes.
 *
 * The ones it only READS — the marker, cover and attachments — keep their
 * conventional names, because they are ordinary vault metadata the reader
 * already curates and renaming them would mean rewriting existing notes.
 * The ones it WRITES are namespaced under `reading_`: `progress` and
 * `last-read` are common enough names that this plugin could quietly
 * overwrite something another plugin, or the reader, was already using.
 */
export interface PropertyNames {
  /** Marker property name. Default `type`. */
  marker: string;
  /** Marker property value that identifies a book note. Default `book`. */
  markerValue: string;
  cover: string;
  attachments: string;
  progress: string;
  lastRead: string;
  furthestRead: string;
  /** List of bookmarked positions (locators), written by the reader's bookmark button. */
  bookmarks: string;
}

/**
 * Which reader opens a format. `plugin` is this plugin's own reader;
 * `default` hands the file to whatever Obsidian would otherwise do with it.
 *
 * Two things this cannot be, both verified against Obsidian's own source:
 * a plugin cannot claim `.pdf` (ViewRegistry.registerExtensions throws on an
 * already-registered extension), so a PDF opened from the file explorer
 * always uses the built-in viewer whatever this says — the choice only
 * governs opening a PDF *book note*. And there is no public un-register, so
 * changing the EPUB choice takes effect on the next plugin load.
 */
export type ReaderChoice = "plugin" | "default";

export interface ReaderChoices {
  epub: ReaderChoice;
  pdf: ReaderChoice;
}

export interface PaneSettings {
  /** This plugin's outline pane. */
  outline: boolean;
  /** This plugin's highlights & notes pane. */
  highlights: boolean;
  /**
   * Close Obsidian's own outline pane once, when the vault opens. It cannot
   * be disabled — `app.internalPlugins` is not public API — so this is a
   * one-shot `detachLeavesOfType`, never a watcher that re-applies itself.
   */
  hideNativeOutline: boolean;
}

/** The properties an exported highlight note carries, by the names the reader chose. */
export interface HighlightNoteProperties {
  /** Link to the book note. */
  book: string;
  type: string;
  /** The chapter or section, from the book's table of contents. */
  section: string;
  page: string;
  created: string;
}

/**
 * Highlights always live in the book note (src/annotations/store.ts); these
 * settings only shape a highlight exported as a note of its own, which
 * embeds the highlight rather than copying it.
 */
export interface HighlightSettings {
  /** A note whose text, with `{{placeholders}}` filled in, becomes an exported note's body. Empty uses the built-in layout. */
  template: string;
  /** Where exported highlight notes go. Empty means the vault root. */
  folder: string;
  /** Put each book's exported notes in a subfolder named after the book. */
  subfolderPerBook: boolean;
  properties: HighlightNoteProperties;
}

/** Where an imported book's note and files go (see src/import/importer.ts). */
export interface ImportSettings {
  /** Folder new book notes are created in. Empty means the vault root. */
  notesFolder: string;
  /**
   * Folder the book file and its cover are moved to. Empty follows Obsidian's
   * own "Default location for new attachments", relative to the new note.
   */
  filesFolder: string;
  /** Folder watched for new EPUBs and PDFs to import. Empty turns watching off. */
  inboxFolder: string;
  /** Fill fields the file does not carry from Open Library. */
  lookUpMetadata: boolean;
  /**
   * PDFs in the inbox the reader said are not books. A PDF is as likely to be
   * a receipt or a paper as a book, so the inbox asks before importing one,
   * and these are not asked about again.
   */
  ignoredPdfs: string[];
}

/** Toolbar state that persists across closing and reopening a book. */
export interface ReaderPreferences {
  /** The scale in use. Recomputed from the pane whenever `pdfFit` is not "none". */
  pdfScale: number;
  pdfFit: PdfFit;
  pdfSpread: SpreadMode;
  /** Text size for reflowable books, as a multiplier of the book's own size. */
  epubTextScale: number;
  epubFlow: EpubFlow;
  /** Line spacing for reflowable books; "normal" leaves it to the book. */
  epubLineSpacing: LineSpacing;
  /** Space either side of a reflowable book's text. */
  epubMargins: Margins;
  epubFont: BookFont;
  epubJustify: boolean;
  epubHyphenate: boolean;
  /** Two pages side by side in paginated flow once the pane is wide enough, or always one. */
  epubSpread: EpubSpread;
  /** The page's palette, for both formats. "auto" follows the vault's theme. */
  readingTheme: ReadingTheme;
  /** The line under the page with the chapter, time left and percentage. */
  showFooter: boolean;
  /**
   * How long the reader takes over one unit, learned as they read, for the
   * time-left estimates: an EPUB location (about 1,600 characters) or a PDF
   * page.
   */
  paceEpubMs: number;
  pacePdfMs: number;
  /** Whether saved highlights are painted into the document. */
  showHighlights: boolean;
  /**
   * The type last chosen in the selection popup, which the "Highlight
   * selection" command writes. A name from
   * {@link Settings.annotationTypes}, or empty when there are none left.
   */
  activeAnnotationType: string;
}

/**
 * Colours handed to types that do not carry one — the defaults, and anything
 * migrated from the bare list of names that earlier versions saved. Chosen to
 * stay legible under `mix-blend-mode: multiply` over a white page.
 */
export const HIGHLIGHT_PALETTE: readonly string[] = [
  "#ffd76e",
  "#7ec4f5",
  "#ff9b9b",
  "#9be5a4",
  "#d3a8f0",
  "#ffc08a",
];

function paletteColor(index: number): string {
  return HIGHLIGHT_PALETTE[index % HIGHLIGHT_PALETTE.length] as string;
}

export type EpubFlow = "scrolled" | "paginated";
export type EpubSpread = "auto" | "none";

/**
 * Whether the PDF scale is pinned to the pane rather than to a number. A
 * stored number alone cannot survive the pane changing size — a page at scale
 * 1 is far wider than a phone — so the fit itself is remembered and
 * re-applied whenever the pane is resized or the device rotated.
 */
export type PdfFit = "none" | "width" | "height" | "page";

/** One reader-configurable highlight kind and the colour it is painted in. */
export interface AnnotationType {
  name: string;
  /** Hex, because that is what Obsidian's own ColorComponent reads and writes. */
  color: string;
}

export interface Settings {
  /** Schema version of this object, so a rename can be migrated once. */
  version: number;
  properties: PropertyNames;
  /** Where read later and wishlist are kept on a book note. */
  status: StatusSettings;
  /**
   * The checkbox property read later used to be, while its notes still have
   * to be moved over to the status list. Cleared once they have been.
   */
  pendingReadLaterMigration?: string;
  /** Book notes with no file still need the wishlist status. Cleared once they have it. */
  pendingWishlistMigration?: boolean;
  /** Reader-configurable highlight types. Never contains `bookmark` — reserved (FR-020a, FR-028a). */
  annotationTypes: AnnotationType[];
  readers: ReaderChoices;
  panes: PaneSettings;
  import: ImportSettings;
  highlights: HighlightSettings;
  reader: ReaderPreferences;
}

/**
 * Bump when a saved value's MEANING changes and old data has to be upgraded.
 * 2: the written properties moved to the `reading_` namespace.
 * 3: read later moved from a checkbox into the status list.
 * 4: books with no file are given the wishlist status.
 */
export const SETTINGS_VERSION = 4;

/** The read later checkbox's name before version 3, unless the reader had renamed it. */
const LEGACY_READ_LATER = "read_later";

/**
 * The names those properties had at version 1. Data saved then pinned these
 * into `data.json` — not because anyone chose them, but because saving any
 * setting persists the whole object — and a saved value normally wins over a
 * default, which would have left the reader writing the old names forever.
 * A name that does NOT appear here was typed by the reader and is kept.
 */
const LEGACY_PROPERTY_NAMES: Partial<Record<keyof PropertyNames, string>> = {
  progress: "progress",
  lastRead: "last-read",
  furthestRead: "furthest-read",
};

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  properties: {
    marker: "type",
    markerValue: "book",
    cover: "cover",
    attachments: "attachments",
    progress: "reading_progress",
    lastRead: "reading_position",
    furthestRead: "furthest_position",
    bookmarks: "bookmarks",
  },
  status: { useTags: true, property: "shelves", readLater: "read-later", wishlist: "wishlist" },
  annotationTypes: [
    { name: "idea", color: "#ffd76e" },
    { name: "question", color: "#7ec4f5" },
    { name: "important", color: "#ff9b9b" },
  ],
  readers: { epub: "plugin", pdf: "plugin" },
  panes: { outline: true, highlights: true, hideNativeOutline: false },
  import: { notesFolder: "Library", filesFolder: "", inboxFolder: "", lookUpMetadata: true, ignoredPdfs: [] },
  highlights: {
    template: "",
    folder: "Highlights",
    subfolderPerBook: true,
    properties: { book: "book", type: "highlight", section: "chapter", page: "page", created: "created" },
  },
  reader: {
    pdfScale: 1,
    pdfFit: "width",
    pdfSpread: "single",
    epubTextScale: 1,
    epubFlow: "scrolled",
    epubLineSpacing: "normal",
    epubMargins: "normal",
    epubFont: "book",
    epubJustify: false,
    epubHyphenate: false,
    epubSpread: "auto",
    readingTheme: "auto",
    showFooter: true,
    paceEpubMs: DEFAULT_PACE_EPUB_MS,
    pacePdfMs: DEFAULT_PACE_PDF_MS,
    showHighlights: true,
    activeAnnotationType: "idea",
  },
};

function mergePace(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clampPace(value) : fallback;
}

function isPdfFit(value: unknown): value is PdfFit {
  return value === "none" || value === "width" || value === "height" || value === "page";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The saved sub-object under `key`, or an empty one when it is missing or the wrong shape. */
function group(saved: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = saved[key];
  return isRecord(value) ? value : {};
}

function mergeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function mergeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

const PROPERTY_KEYS = Object.keys(DEFAULT_SETTINGS.properties) as (keyof PropertyNames)[];

function mergeProperties(saved: unknown, version: number): PropertyNames {
  const savedProperties = isRecord(saved) ? saved : {};
  const result: PropertyNames = { ...DEFAULT_SETTINGS.properties };
  for (const key of PROPERTY_KEYS) {
    const value = savedProperties[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    // Pre-namespace data carries the old defaults; those are upgraded rather
    // than honoured. Anything else is a real override and is kept.
    if (version < 2 && LEGACY_PROPERTY_NAMES[key] === value) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Accepts both shapes this has been saved in: the current `{name, color}`
 * objects, and the bare array of names written before types carried a colour.
 * A migrated name — or one whose colour is missing or unusable — is given one
 * from the palette by position, so an upgrade never lands on a book full of
 * identically-coloured highlights.
 */
function mergeAnnotationTypes(saved: unknown): AnnotationType[] {
  if (!Array.isArray(saved)) return DEFAULT_SETTINGS.annotationTypes.map((type) => ({ ...type }));
  const types: AnnotationType[] = [];
  for (const entry of saved) {
    const name = typeof entry === "string" ? entry : isRecord(entry) && typeof entry["name"] === "string" ? entry["name"] : "";
    if (name.trim() === "" || name === RESERVED_ENTRY_TYPE) continue;
    const savedColor = isRecord(entry) ? entry["color"] : undefined;
    const color = typeof savedColor === "string" && savedColor.trim() !== "" ? savedColor : paletteColor(types.length);
    types.push({ name, color });
  }
  return types;
}

/**
 * The saved choice when it still names a real type. A type the reader has
 * since deleted or renamed falls back to the first one, so the toolbar cannot
 * end up highlighting in a type that no longer exists.
 */
function mergeActiveType(saved: unknown, types: AnnotationType[]): string {
  const first = types[0]?.name ?? "";
  if (typeof saved !== "string") return first;
  return types.some((type) => type.name === saved) ? saved : first;
}

function mergeReaderChoice(value: unknown, fallback: ReaderChoice): ReaderChoice {
  return value === "plugin" || value === "default" ? value : fallback;
}

function mergeReaders(saved: Record<string, unknown>): ReaderChoices {
  const from = group(saved, "readers");
  return {
    epub: mergeReaderChoice(from["epub"], DEFAULT_SETTINGS.readers.epub),
    pdf: mergeReaderChoice(from["pdf"], DEFAULT_SETTINGS.readers.pdf),
  };
}

function mergePanes(saved: Record<string, unknown>): PaneSettings {
  const from = group(saved, "panes");
  return {
    outline: mergeBoolean(from["outline"], DEFAULT_SETTINGS.panes.outline),
    highlights: mergeBoolean(from["highlights"], DEFAULT_SETTINGS.panes.highlights),
    hideNativeOutline: mergeBoolean(from["hideNativeOutline"], DEFAULT_SETTINGS.panes.hideNativeOutline),
  };
}

/** A folder path as typed, without the slashes a reader might add at either end. */
function mergeFolder(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : fallback;
}

function mergeStatus(saved: Record<string, unknown>): StatusSettings {
  const from = group(saved, "status");
  const defaults = DEFAULT_SETTINGS.status;
  const useTags = mergeBoolean(from["useTags"], defaults.useTags);
  const value = (key: "property" | "readLater" | "wishlist"): string => {
    const raw = from[key];
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : defaults[key];
  };
  return {
    useTags,
    property: value("property"),
    readLater: normalizeStatus(value("readLater"), useTags),
    wishlist: normalizeStatus(value("wishlist"), useTags),
  };
}

/**
 * The checkbox property whose notes still need moving into the status list:
 * the saved name from before version 3, or the one a migration in progress
 * left behind. Nothing for a fresh install, which has no notes using it.
 */
function mergePendingReadLater(saved: Record<string, unknown>, version: number): string | undefined {
  const pending = saved["pendingReadLaterMigration"];
  if (typeof pending === "string" && pending.trim() !== "") return pending;
  if (version >= 3 || Object.keys(saved).length === 0) return undefined;
  const properties = group(saved, "properties");
  const name = properties["readLater"];
  return typeof name === "string" && name.trim() !== "" ? name.trim() : LEGACY_READ_LATER;
}

/** Whether notes from before version 4 still need the wishlist status. Nothing to do on a fresh install. */
function mergePendingWishlist(saved: Record<string, unknown>, version: number): boolean {
  if (saved["pendingWishlistMigration"] === true) return true;
  return version < 4 && Object.keys(saved).length > 0;
}

function mergeImport(saved: Record<string, unknown>): ImportSettings {
  const from = group(saved, "import");
  const defaults = DEFAULT_SETTINGS.import;
  return {
    notesFolder: mergeFolder(from["notesFolder"], defaults.notesFolder),
    filesFolder: mergeFolder(from["filesFolder"], defaults.filesFolder),
    inboxFolder: mergeFolder(from["inboxFolder"], defaults.inboxFolder),
    lookUpMetadata: mergeBoolean(from["lookUpMetadata"], defaults.lookUpMetadata),
    ignoredPdfs: Array.isArray(from["ignoredPdfs"])
      ? from["ignoredPdfs"].filter((path): path is string => typeof path === "string")
      : [],
  };
}

function mergeHighlights(saved: Record<string, unknown>): HighlightSettings {
  const from = group(saved, "highlights");
  const defaults = DEFAULT_SETTINGS.highlights;
  const savedProperties = isRecord(from["properties"]) ? from["properties"] : {};
  const properties = { ...defaults.properties };
  for (const key of Object.keys(properties) as (keyof HighlightNoteProperties)[]) {
    const value = savedProperties[key];
    if (typeof value === "string" && value.trim() !== "") properties[key] = value.trim();
  }
  return {
    template: typeof from["template"] === "string" ? from["template"].trim() : defaults.template,
    folder: mergeFolder(from["folder"], defaults.folder),
    subfolderPerBook: mergeBoolean(from["subfolderPerBook"], defaults.subfolderPerBook),
    properties,
  };
}

/** A saved scale is clamped rather than rejected — a stale value is still a usable one. */
function mergeScale(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clampScale(value) : fallback;
}

function mergeReaderPreferences(saved: Record<string, unknown>, types: AnnotationType[]): ReaderPreferences {
  const from = group(saved, "reader");
  const defaults = DEFAULT_SETTINGS.reader;
  return {
    pdfScale: mergeScale(from["pdfScale"], defaults.pdfScale),
    pdfFit: isPdfFit(from["pdfFit"]) ? from["pdfFit"] : defaults.pdfFit,
    pdfSpread: isSpreadMode(from["pdfSpread"]) ? from["pdfSpread"] : defaults.pdfSpread,
    epubTextScale: mergeScale(from["epubTextScale"], defaults.epubTextScale),
    epubFlow: from["epubFlow"] === "paginated" || from["epubFlow"] === "scrolled" ? from["epubFlow"] : defaults.epubFlow,
    epubLineSpacing: isLineSpacing(from["epubLineSpacing"]) ? from["epubLineSpacing"] : defaults.epubLineSpacing,
    epubMargins: isMargins(from["epubMargins"]) ? from["epubMargins"] : defaults.epubMargins,
    epubFont: isBookFont(from["epubFont"]) ? from["epubFont"] : defaults.epubFont,
    epubJustify: mergeBoolean(from["epubJustify"], defaults.epubJustify),
    epubHyphenate: mergeBoolean(from["epubHyphenate"], defaults.epubHyphenate),
    epubSpread: from["epubSpread"] === "none" || from["epubSpread"] === "auto" ? from["epubSpread"] : defaults.epubSpread,
    readingTheme: isReadingTheme(from["readingTheme"]) ? from["readingTheme"] : defaults.readingTheme,
    showFooter: mergeBoolean(from["showFooter"], defaults.showFooter),
    paceEpubMs: mergePace(from["paceEpubMs"], defaults.paceEpubMs),
    pacePdfMs: mergePace(from["pacePdfMs"], defaults.pacePdfMs),
    showHighlights: mergeBoolean(from["showHighlights"], defaults.showHighlights),
    activeAnnotationType: mergeActiveType(from["activeAnnotationType"], types),
  };
}

/**
 * Builds a complete Settings object from whatever was loaded from disk,
 * falling back to defaults per-field rather than rejecting the whole blob.
 * Unknown top-level keys (e.g. from a newer plugin version) are preserved,
 * not dropped.
 */
export function mergeSettings(saved: unknown): Settings {
  const savedObject = isRecord(saved) ? saved : {};
  // Absent means version 1 — the schema predates this field.
  const version = typeof savedObject["version"] === "number" ? savedObject["version"] : 1;
  const {
    version: _version,
    properties: _properties,
    annotationTypes: _annotationTypes,
    readers: _readers,
    panes: _panes,
    // The OPDS catalog was dropped; its old address is not carried forward.
    catalog: _catalog,
    import: _import,
    highlights: _highlights,
    reader: _reader,
    status: _status,
    pendingReadLaterMigration: _pendingReadLaterMigration,
    pendingWishlistMigration: _pendingWishlistMigration,
    ...rest
  } = savedObject;
  const annotationTypes = mergeAnnotationTypes(savedObject.annotationTypes);
  const pendingReadLaterMigration = mergePendingReadLater(savedObject, version);
  return {
    ...rest,
    version: SETTINGS_VERSION,
    properties: mergeProperties(savedObject.properties, version),
    annotationTypes,
    readers: mergeReaders(savedObject),
    panes: mergePanes(savedObject),
    import: mergeImport(savedObject),
    highlights: mergeHighlights(savedObject),
    reader: mergeReaderPreferences(savedObject, annotationTypes),
    status: mergeStatus(savedObject),
    ...(pendingReadLaterMigration === undefined ? {} : { pendingReadLaterMigration }),
    ...(mergePendingWishlist(savedObject, version) ? { pendingWishlistMigration: true } : {}),
  };
}
