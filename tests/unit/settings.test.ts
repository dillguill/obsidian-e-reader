import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../../src/settings/settings-model";
import { RESERVED_ENTRY_TYPE } from "../../src/core/types";

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
    };
    expect(mergeSettings(custom)).toEqual(custom);
  });
});
