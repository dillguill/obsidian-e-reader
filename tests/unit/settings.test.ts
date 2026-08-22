import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, mergeSettings } from "../../src/settings/settings-model";
import { RESERVED_ENTRY_TYPE } from "../../src/core/types";
import { MAX_SCALE, MIN_SCALE } from "../../src/reader/zoom";

describe("DEFAULT_SETTINGS", () => {
  it("uses the marker property `type` with value `book`", () => {
    expect(DEFAULT_SETTINGS.properties.marker).toBe("type");
    expect(DEFAULT_SETTINGS.properties.markerValue).toBe("book");
  });

  // The properties the reader READS are ordinary vault metadata the user
  // curates, so they keep their plain names. The ones it WRITES are
  // namespaced, because `progress` and `last-read` are common enough that
  // this plugin could quietly clobber something else's.
  it("leaves the properties it only reads under their conventional names", () => {
    expect(DEFAULT_SETTINGS.properties).toMatchObject({
      marker: "type",
      markerValue: "book",
      cover: "cover",
      attachments: "attachments",
    });
  });

  it("namespaces the properties it writes, in snake_case", () => {
    expect(DEFAULT_SETTINGS.properties).toMatchObject({
      progress: "reading_progress",
      lastRead: "reading_position",
      furthestRead: "furthest_position",
    });
  });

  it("ships a default annotation types list that excludes the reserved bookmark type", () => {
    expect(DEFAULT_SETTINGS.annotationTypes.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.annotationTypes.map((type) => type.name)).not.toContain(RESERVED_ENTRY_TYPE);
  });

  it("gives every default type its own colour", () => {
    const colors = DEFAULT_SETTINGS.annotationTypes.map((type) => type.color);
    expect(colors.every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    expect(new Set(colors).size).toBe(colors.length);
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

  it("drops entries that carry no usable name", () => {
    const merged = mergeSettings({ annotationTypes: [{ name: "idea", color: "#111111" }, 42, null, { color: "#222222" }] });
    expect(merged.annotationTypes.map((type) => type.name)).toEqual(["idea"]);
  });

  it("never allows the reserved bookmark type into the annotation types list, even if saved data carries it", () => {
    const merged = mergeSettings({
      annotationTypes: [{ name: "idea", color: "#111111" }, { name: RESERVED_ENTRY_TYPE, color: "#222222" }],
    });
    expect(merged.annotationTypes.map((type) => type.name)).not.toContain(RESERVED_ENTRY_TYPE);
  });

  // Data written before types carried a colour is a plain array of strings.
  it("migrates a saved list of bare type names, giving each a colour", () => {
    const merged = mergeSettings({ annotationTypes: ["idea", "question"] });
    expect(merged.annotationTypes.map((type) => type.name)).toEqual(["idea", "question"]);
    expect(merged.annotationTypes[0]?.color).toBe(DEFAULT_SETTINGS.annotationTypes[0]?.color);
    expect(merged.annotationTypes[1]?.color).toBe(DEFAULT_SETTINGS.annotationTypes[1]?.color);
  });

  it("migrates a mixed list, and keeps the reserved type out of it", () => {
    const merged = mergeSettings({ annotationTypes: ["idea", { name: "quote", color: "#abcdef" }, RESERVED_ENTRY_TYPE] });
    expect(merged.annotationTypes.map((type) => type.name)).toEqual(["idea", "quote"]);
    expect(merged.annotationTypes[1]?.color).toBe("#abcdef");
  });

  it("gives a type with a missing or unusable colour one from the palette", () => {
    const merged = mergeSettings({ annotationTypes: [{ name: "idea" }, { name: "quote", color: 42 }] });
    expect(merged.annotationTypes[0]?.color).toBe(DEFAULT_SETTINGS.annotationTypes[0]?.color);
    expect(merged.annotationTypes[1]?.color).toBe(DEFAULT_SETTINGS.annotationTypes[1]?.color);
  });

  it("keeps assigning colours past the end of the palette rather than running out", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const merged = mergeSettings({ annotationTypes: names });
    expect(merged.annotationTypes).toHaveLength(names.length);
    expect(merged.annotationTypes.every((type) => /^#[0-9a-f]{6}$/i.test(type.color))).toBe(true);
  });

  it("preserves an unknown extra top-level key instead of dropping it", () => {
    const merged = mergeSettings({ someFutureField: "keep-me" });
    expect(merged).toMatchObject({ someFutureField: "keep-me" });
    expect(merged.properties).toEqual(DEFAULT_SETTINGS.properties);
    expect(merged.annotationTypes).toEqual(DEFAULT_SETTINGS.annotationTypes);
  });

  it("passes a fully valid custom settings object through unchanged", () => {
    const custom = {
      version: SETTINGS_VERSION,
      properties: {
        marker: "kind",
        markerValue: "novel",
        cover: "thumbnail",
        attachments: "files",
        progress: "percent",
        lastRead: "last-position",
        furthestRead: "furthest-position",
      },
      annotationTypes: [
        { name: "idea", color: "#111111" },
        { name: "question", color: "#222222" },
      ],
      readers: { epub: "plugin", pdf: "default" },
      panes: { outline: false, highlights: true, hideNativeOutline: true },
      catalog: { url: "https://example.org/opds" },
      reader: {
        pdfScale: 1.25,
        pdfFit: "none",
        pdfSpread: "even",
        pdfAdaptToTheme: true,
        epubTextScale: 1.1,
        epubFlow: "paginated",
        showHighlights: false,
        activeAnnotationType: "question",
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
      pdfFit: "width",
      pdfSpread: "single",
      pdfAdaptToTheme: false,
      epubTextScale: 1,
      epubFlow: "scrolled",
      showHighlights: true,
      activeAnnotationType: DEFAULT_SETTINGS.annotationTypes[0]?.name,
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

describe("the active highlight type", () => {
  it("defaults to the first configured type", () => {
    expect(DEFAULT_SETTINGS.reader.activeAnnotationType).toBe(DEFAULT_SETTINGS.annotationTypes[0]?.name);
  });

  it("keeps a saved choice that still exists", () => {
    const merged = mergeSettings({ reader: { activeAnnotationType: "important" } });
    expect(merged.reader.activeAnnotationType).toBe("important");
  });

  // The reader can delete or rename the type that was active; the toolbar has
  // to land on something real rather than highlight in a type that is gone.
  it("falls back to the first type when the saved choice no longer exists", () => {
    const merged = mergeSettings({
      annotationTypes: [{ name: "quote", color: "#abcdef" }],
      reader: { activeAnnotationType: "important" },
    });
    expect(merged.reader.activeAnnotationType).toBe("quote");
  });

  it("is empty when every type has been removed", () => {
    const merged = mergeSettings({ annotationTypes: [], reader: { activeAnnotationType: "idea" } });
    expect(merged.annotationTypes).toEqual([]);
    expect(merged.reader.activeAnnotationType).toBe("");
  });
});

// Settings saved before the written properties were namespaced pinned the old
// defaults into data.json — not because anyone chose them, but because saving
// any setting persisted the whole object. Loading that data must not leave the
// reader writing `progress`/`last-read` forever.
describe("migrating settings saved before the properties were namespaced", () => {
  const legacy = {
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
  };

  it("upgrades names that were merely the old defaults", () => {
    const merged = mergeSettings(legacy);
    expect(merged.properties.progress).toBe("reading_progress");
    expect(merged.properties.lastRead).toBe("reading_position");
    expect(merged.properties.furthestRead).toBe("furthest_position");
  });

  it("leaves the read-only property names alone", () => {
    const merged = mergeSettings(legacy);
    expect(merged.properties.marker).toBe("type");
    expect(merged.properties.cover).toBe("cover");
    expect(merged.properties.attachments).toBe("attachments");
  });

  it("keeps a genuine override, which was never the old default", () => {
    const merged = mergeSettings({ properties: { ...legacy.properties, progress: "pct" } });
    expect(merged.properties.progress).toBe("pct");
    expect(merged.properties.lastRead).toBe("reading_position");
  });

  it("stamps a version so the upgrade runs once", () => {
    expect(mergeSettings(legacy).version).toBe(SETTINGS_VERSION);
    expect(DEFAULT_SETTINGS.version).toBe(SETTINGS_VERSION);
  });

  // Once migrated, `progress` can only be there because the reader typed it.
  it("does not re-upgrade a name deliberately set back after migrating", () => {
    const merged = mergeSettings({ version: SETTINGS_VERSION, properties: { progress: "progress" } });
    expect(merged.properties.progress).toBe("progress");
  });

  it("drops the removed read-state property name", () => {
    expect(mergeSettings(legacy).properties).not.toHaveProperty("readState");
  });
});

// A page at scale 1 is far wider than a phone, so a stored NUMBER cannot be
// the whole answer: the fit has to be re-applied when the pane changes size,
// which means remembering that a fit was asked for at all.
describe("pdf fit mode", () => {
  it("fits to width out of the box", () => {
    expect(DEFAULT_SETTINGS.reader.pdfFit).toBe("width");
  });

  it("keeps a saved fit mode", () => {
    expect(mergeSettings({ reader: { pdfFit: "height" } }).reader.pdfFit).toBe("height");
    expect(mergeSettings({ reader: { pdfFit: "none" } }).reader.pdfFit).toBe("none");
  });

  it("falls back for an unrecognised mode", () => {
    expect(mergeSettings({ reader: { pdfFit: "sideways" } }).reader.pdfFit).toBe("width");
    expect(mergeSettings({ reader: { pdfFit: 3 } }).reader.pdfFit).toBe("width");
  });

  // Settings written before this existed carry a scale and no fit; they get
  // the fit default, which is what makes an old vault stop overflowing.
  it("gives settings saved without a fit the default one", () => {
    expect(mergeSettings({ reader: { pdfScale: 1 } }).reader.pdfFit).toBe("width");
  });
});
