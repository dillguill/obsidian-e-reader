import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../../src/settings/settings-model";
import { RESERVED_ENTRY_TYPE } from "../../src/core/types";
import { MAX_SCALE, MIN_SCALE } from "../../src/reader/zoom";

describe("DEFAULT_SETTINGS", () => {
  it("uses the marker property `type` with value `book`", () => {
    expect(DEFAULT_SETTINGS.properties.marker).toBe("type");
    expect(DEFAULT_SETTINGS.properties.markerValue).toBe("book");
  });

  it("uses kebab-case defaults for the rest of the property names", () => {
    expect(DEFAULT_SETTINGS.properties).toMatchObject({
      cover: "cover",
      attachments: "attachments",
      readState: "read-state",
      progress: "progress",
      lastRead: "last-read",
      furthestRead: "furthest-read",
    });
  });

  it("ships a default annotation types list that excludes the reserved bookmark type", () => {
    expect(DEFAULT_SETTINGS.annotationTypes.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.annotationTypes).not.toContain(RESERVED_ENTRY_TYPE);
  });
});

describe("mergeSettings tolerates missing/partial/corrupt saved data", () => {
  it("falls back to defaults for null", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults for undefined", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults for an empty object", () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults when saved data is a primitive, not an object", () => {
    expect(mergeSettings("not-settings")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid property overrides and falls back per-field for invalid ones", () => {
    const merged = mergeSettings({
      properties: {
        marker: "kind", // valid override
        markerValue: 123, // wrong type -> default
        cover: "", // empty -> default
        // attachments, readState, progress, lastRead, furthestRead absent -> defaults
      },
    });

    expect(merged.properties).toEqual({
      marker: "kind",
      markerValue: DEFAULT_SETTINGS.properties.markerValue,
      cover: DEFAULT_SETTINGS.properties.cover,
      attachments: DEFAULT_SETTINGS.properties.attachments,
      readState: DEFAULT_SETTINGS.properties.readState,
      progress: DEFAULT_SETTINGS.properties.progress,
      lastRead: DEFAULT_SETTINGS.properties.lastRead,
      furthestRead: DEFAULT_SETTINGS.properties.furthestRead,
    });
  });

  it("falls back to the full default properties object when `properties` is the wrong type", () => {
    const merged = mergeSettings({ properties: "not-an-object" });
    expect(merged.properties).toEqual(DEFAULT_SETTINGS.properties);
  });

  it("falls back to the default annotation types list when the saved value is not an array", () => {
    const merged = mergeSettings({ annotationTypes: "idea, question" });
    expect(merged.annotationTypes).toEqual(DEFAULT_SETTINGS.annotationTypes);
  });

  it("drops non-string entries from a saved annotation types array", () => {
    const merged = mergeSettings({ annotationTypes: ["idea", 42, null, "question"] });
    expect(merged.annotationTypes).toEqual(["idea", "question"]);
  });

  it("never allows the reserved bookmark type into the annotation types list, even if saved data carries it", () => {
    const merged = mergeSettings({ annotationTypes: ["idea", RESERVED_ENTRY_TYPE, "question"] });
    expect(merged.annotationTypes).not.toContain(RESERVED_ENTRY_TYPE);
    expect(merged.annotationTypes).toEqual(["idea", "question"]);
  });

  it("preserves an unknown extra top-level key instead of dropping it", () => {
    const merged = mergeSettings({ someFutureField: "keep-me" });
    expect(merged).toMatchObject({ someFutureField: "keep-me" });
    expect(merged.properties).toEqual(DEFAULT_SETTINGS.properties);
    expect(merged.annotationTypes).toEqual(DEFAULT_SETTINGS.annotationTypes);
  });

  it("passes a fully valid custom settings object through unchanged", () => {
    const custom = {
      properties: {
        marker: "kind",
        markerValue: "novel",
        cover: "thumbnail",
        attachments: "files",
        readState: "status",
        progress: "percent",
        lastRead: "last-position",
        furthestRead: "furthest-position",
      },
      annotationTypes: ["idea", "question"],
      readers: { epub: "plugin", pdf: "default" },
      panes: { outline: false, highlights: true, hideNativeOutline: true },
      catalog: { url: "https://example.org/opds" },
      reader: {
        pdfScale: 1.25,
        pdfSpread: "even",
        pdfAdaptToTheme: true,
        epubTextScale: 1.1,
        epubFlow: "paginated",
        showHighlights: false,
      },
    };
    expect(mergeSettings(custom)).toEqual(custom);
  });
});

describe("reader engine choice", () => {
  it("defaults both formats to this plugin's own reader", () => {
    expect(DEFAULT_SETTINGS.readers).toEqual({ epub: "plugin", pdf: "plugin" });
  });

  it("keeps a valid saved choice", () => {
    expect(mergeSettings({ readers: { pdf: "default" } }).readers).toEqual({ epub: "plugin", pdf: "default" });
  });

  it("falls back per-format for an unrecognised choice", () => {
    expect(mergeSettings({ readers: { epub: "foliate", pdf: 7 } }).readers).toEqual(DEFAULT_SETTINGS.readers);
  });
});

describe("sidebar pane toggles", () => {
  it("ships both of this plugin's panes enabled and leaves Obsidian's outline alone", () => {
    expect(DEFAULT_SETTINGS.panes).toEqual({ outline: true, highlights: true, hideNativeOutline: false });
  });

  it("keeps valid saved toggles and falls back per-field", () => {
    expect(mergeSettings({ panes: { outline: false, highlights: "yes" } }).panes).toEqual({
      outline: false,
      highlights: true,
      hideNativeOutline: false,
    });
  });
});

describe("catalog settings", () => {
  it("ships with no catalog configured", () => {
    expect(DEFAULT_SETTINGS.catalog.url).toBe("");
  });

  it("keeps a saved url and ignores a non-string one", () => {
    expect(mergeSettings({ catalog: { url: "https://example.org/opds" } }).catalog.url).toBe("https://example.org/opds");
    expect(mergeSettings({ catalog: { url: 42 } }).catalog.url).toBe("");
  });
});

describe("remembered reader preferences", () => {
  it("defaults to actual size, single pages, scrolled text, and highlights shown", () => {
    expect(DEFAULT_SETTINGS.reader).toEqual({
      pdfScale: 1,
      pdfSpread: "single",
      pdfAdaptToTheme: false,
      epubTextScale: 1,
      epubFlow: "scrolled",
      showHighlights: true,
    });
  });

  it("keeps saved scales and modes", () => {
    const merged = mergeSettings({
      reader: { pdfScale: 1.5, pdfSpread: "odd", epubFlow: "paginated", showHighlights: false },
    });
    expect(merged.reader.pdfScale).toBe(1.5);
    expect(merged.reader.pdfSpread).toBe("odd");
    expect(merged.reader.epubFlow).toBe("paginated");
    expect(merged.reader.showHighlights).toBe(false);
  });

  it("clamps a saved scale into the supported zoom range", () => {
    expect(mergeSettings({ reader: { pdfScale: 99 } }).reader.pdfScale).toBe(MAX_SCALE);
    expect(mergeSettings({ reader: { epubTextScale: 0 } }).reader.epubTextScale).toBe(MIN_SCALE);
  });

  it("falls back for an unrecognised spread mode or flow", () => {
    const merged = mergeSettings({ reader: { pdfSpread: "triple", epubFlow: "sideways" } });
    expect(merged.reader.pdfSpread).toBe("single");
    expect(merged.reader.epubFlow).toBe("scrolled");
  });
});
