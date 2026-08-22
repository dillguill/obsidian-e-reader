import { describe, expect, it } from "vitest";
import type { BasesPropertyId, BasesViewConfig } from "obsidian";
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_CARD_SIZE,
  readLibraryViewConfig,
} from "../../src/library/view-config";

/** What the reader writes by default; the overlays fall back to these. */
const DEFAULT_PROPERTIES = { progress: "reading_progress" };

function fakeConfig(values: Record<string, unknown>): BasesViewConfig {
  return {
    get: (key: string) => values[key],
    getAsPropertyId: (key: string) =>
      typeof values[key] === "string" ? (values[key] as BasesPropertyId) : null,
  } as unknown as BasesViewConfig;
}

describe("readLibraryViewConfig", () => {
  it("reads the same keys the built-in Cards view uses", () => {
    const cfg = readLibraryViewConfig(
      fakeConfig({ image: "note.cover", imageFit: "contain", imageAspectRatio: 1.5, cardSize: 240 }),
      DEFAULT_PROPERTIES,
    );
    expect(cfg.imageProperty).toBe("note.cover");
    expect(cfg.imageFitContain).toBe(true);
    expect(cfg.imageAspectRatio).toBe(1.5);
    expect(cfg.cardSize).toBe(240);
  });

  it("defaults to the built-in view's own defaults", () => {
    const cfg = readLibraryViewConfig(fakeConfig({}), DEFAULT_PROPERTIES);
    expect(cfg.cardSize).toBe(DEFAULT_CARD_SIZE);
    expect(cfg.imageAspectRatio).toBe(DEFAULT_ASPECT_RATIO);
    expect(cfg.imageFitContain).toBe(false);
    expect(cfg.imageProperty).toBe("note.cover");
  });

  it.each([null, undefined, 0, -5, "200", NaN, {}, true])(
    "falls back to the default card size for %s",
    (value) => {
      expect(readLibraryViewConfig(fakeConfig({ cardSize: value }), DEFAULT_PROPERTIES).cardSize).toBe(DEFAULT_CARD_SIZE);
    },
  );

  it.each([null, undefined, 0, -1, "1.5", NaN])(
    "falls back to the default aspect ratio for %s",
    (value) => {
      expect(readLibraryViewConfig(fakeConfig({ imageAspectRatio: value }), DEFAULT_PROPERTIES).imageAspectRatio).toBe(
        DEFAULT_ASPECT_RATIO,
      );
    },
  );

  it("binds the plugin's own progress property", () => {
    const cfg = readLibraryViewConfig(fakeConfig({ progressProperty: "note.progress" }), DEFAULT_PROPERTIES);
    expect(cfg.progressProperty).toBe("note.progress");
  });

  it("falls back to the reader's own property when the .base binds nothing", () => {
    const cfg = readLibraryViewConfig(fakeConfig({}), DEFAULT_PROPERTIES);
    expect(cfg.progressProperty).toBe("note.reading_progress");
  });

  it("reads progressDisplay, defaulting to bar", () => {
    expect(readLibraryViewConfig(fakeConfig({ progressDisplay: "percent" }), DEFAULT_PROPERTIES).progressDisplay).toBe("percent");
    expect(readLibraryViewConfig(fakeConfig({ progressDisplay: "nonsense" }), DEFAULT_PROPERTIES).progressDisplay).toBe("bar");
    expect(readLibraryViewConfig(fakeConfig({}), DEFAULT_PROPERTIES).progressDisplay).toBe("bar");
  });
});

describe("overlay bindings fall back to the reader's configured properties", () => {
  const properties = { progress: "reading_progress" };

  it("binds the overlays without any .base configuration", () => {
    const config = readLibraryViewConfig(fakeConfig({}), properties);
    expect(config.progressProperty).toBe("note.reading_progress");
  });

  it("follows a renamed property, so the overlays track what the reader writes", () => {
    const config = readLibraryViewConfig(fakeConfig({}), { progress: "pct" });
    expect(config.progressProperty).toBe("note.pct");
  });

  // The fallback is a default, not an override: a .base that binds these
  // explicitly — to a formula, or to a differently-named property — wins.
  it("lets an explicit binding in the .base win", () => {
    const config = readLibraryViewConfig(fakeConfig({ progressProperty: "formula.pct" }), properties);
    expect(config.progressProperty).toBe("formula.pct");
  });

  it("leaves the overlays unbound when the reader has cleared the name", () => {
    const config = readLibraryViewConfig(fakeConfig({}), { progress: "" });
    expect(config.progressProperty).toBeNull();
  });
});
