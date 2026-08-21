// Plugin settings: reader-configurable frontmatter property names (FR-006),
// the annotation type set (FR-020a), which reader handles each format, which
// sidebar panes are on, the catalog address, and the reader preferences that
// have to survive closing a book. Property names default to kebab-case,
// matching the frontmatter keys the plugin itself writes. See
// specs/001-bases-ereader/data-model.md for the property-by-property
// rationale.
//
// Everything loaded from disk is merged FIELD BY FIELD against the defaults
// rather than accepted or rejected wholesale: a `data.json` that is partly
// from an older version, partly hand-edited, or partly corrupt still yields a
// complete, valid Settings object.

import { RESERVED_ENTRY_TYPE } from "../core/types";
import { type SpreadMode, isSpreadMode } from "../reader/spread";
import { clampScale } from "../reader/zoom";

export interface PropertyNames {
  /** Marker property name. Default `type`. */
  marker: string;
  /** Marker property value that identifies a book note. Default `book`. */
  markerValue: string;
  cover: string;
  attachments: string;
  readState: string;
  progress: string;
  lastRead: string;
  furthestRead: string;
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

export interface CatalogSettings {
  /** Address of the OPDS 1.2 catalog to search. Empty when none is configured. */
  url: string;
}

/** Toolbar state that persists across closing and reopening a book. */
export interface ReaderPreferences {
  pdfScale: number;
  pdfSpread: SpreadMode;
  pdfAdaptToTheme: boolean;
  /** Text size for reflowable books, as a multiplier of the book's own size. */
  epubTextScale: number;
  epubFlow: EpubFlow;
  /** Whether saved highlights are painted into the document. */
  showHighlights: boolean;
  /**
   * The type the reader's highlight mode writes. A name from
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

/** One reader-configurable highlight kind and the colour it is painted in. */
export interface AnnotationType {
  name: string;
  /** Hex, because that is what Obsidian's own ColorComponent reads and writes. */
  color: string;
}

export interface Settings {
  properties: PropertyNames;
  /** Reader-configurable highlight types. Never contains `bookmark` — reserved (FR-020a, FR-028a). */
  annotationTypes: AnnotationType[];
  readers: ReaderChoices;
  panes: PaneSettings;
  catalog: CatalogSettings;
  reader: ReaderPreferences;
}

export const DEFAULT_SETTINGS: Settings = {
  properties: {
    marker: "type",
    markerValue: "book",
    cover: "cover",
    attachments: "attachments",
    readState: "read-state",
    progress: "progress",
    lastRead: "last-read",
    furthestRead: "furthest-read",
  },
  annotationTypes: [
    { name: "idea", color: "#ffd76e" },
    { name: "question", color: "#7ec4f5" },
    { name: "important", color: "#ff9b9b" },
  ],
  readers: { epub: "plugin", pdf: "plugin" },
  panes: { outline: true, highlights: true, hideNativeOutline: false },
  catalog: { url: "" },
  reader: {
    pdfScale: 1,
    pdfSpread: "single",
    pdfAdaptToTheme: false,
    epubTextScale: 1,
    epubFlow: "scrolled",
    showHighlights: true,
    activeAnnotationType: "idea",
  },
};

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

function mergeProperties(saved: unknown): PropertyNames {
  const savedProperties = isRecord(saved) ? saved : {};
  const result: PropertyNames = { ...DEFAULT_SETTINGS.properties };
  for (const key of PROPERTY_KEYS) {
    const value = savedProperties[key];
    if (typeof value === "string" && value.trim() !== "") {
      result[key] = value;
    }
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

function mergeCatalog(saved: Record<string, unknown>): CatalogSettings {
  const from = group(saved, "catalog");
  return { url: mergeString(from["url"], DEFAULT_SETTINGS.catalog.url) };
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
    pdfSpread: isSpreadMode(from["pdfSpread"]) ? from["pdfSpread"] : defaults.pdfSpread,
    pdfAdaptToTheme: mergeBoolean(from["pdfAdaptToTheme"], defaults.pdfAdaptToTheme),
    epubTextScale: mergeScale(from["epubTextScale"], defaults.epubTextScale),
    epubFlow: from["epubFlow"] === "paginated" || from["epubFlow"] === "scrolled" ? from["epubFlow"] : defaults.epubFlow,
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
  const {
    properties: _properties,
    annotationTypes: _annotationTypes,
    readers: _readers,
    panes: _panes,
    catalog: _catalog,
    reader: _reader,
    ...rest
  } = savedObject;
  const annotationTypes = mergeAnnotationTypes(savedObject.annotationTypes);
  return {
    ...rest,
    properties: mergeProperties(savedObject.properties),
    annotationTypes,
    readers: mergeReaders(savedObject),
    panes: mergePanes(savedObject),
    catalog: mergeCatalog(savedObject),
    reader: mergeReaderPreferences(savedObject, annotationTypes),
  };
}
