// Plugin settings: reader-configurable frontmatter property names (FR-006)
// and the annotation type set (FR-020a). Property names default to
// kebab-case, matching the frontmatter keys the plugin itself writes. See
// specs/001-bases-ereader/data-model.md for the property-by-property
// rationale.

import { RESERVED_ENTRY_TYPE } from "../core/types";

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

export interface Settings {
  properties: PropertyNames;
  /** Reader-configurable highlight/bookmark types. Never contains `bookmark` — reserved (FR-020a, FR-028a). */
  annotationTypes: string[];
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
  annotationTypes: ["idea", "question", "important"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function mergeAnnotationTypes(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [...DEFAULT_SETTINGS.annotationTypes];
  return saved.filter((entry): entry is string => typeof entry === "string" && entry !== RESERVED_ENTRY_TYPE);
}

/**
 * Builds a complete Settings object from whatever was loaded from disk,
 * falling back to defaults per-field rather than rejecting the whole blob.
 * Unknown top-level keys (e.g. from a newer plugin version) are preserved,
 * not dropped.
 */
export function mergeSettings(saved: unknown): Settings {
  const savedObject = isRecord(saved) ? saved : {};
  const { properties: _properties, annotationTypes: _annotationTypes, ...rest } = savedObject;
  return {
    ...rest,
    properties: mergeProperties(savedObject.properties),
    annotationTypes: mergeAnnotationTypes(savedObject.annotationTypes),
  };
}
