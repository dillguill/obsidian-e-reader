import { describe, expect, it } from "vitest";
import type { BasesPropertyId, BasesViewConfig } from "obsidian";
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_CARD_SIZE,
  readLibraryViewConfig,
} from "../../src/library/view-config";

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
    );
    expect(cfg.imageProperty).toBe("note.cover");
    expect(cfg.imageFitContain).toBe(true);
    expect(cfg.imageAspectRatio).toBe(1.5);
    expect(cfg.cardSize).toBe(240);
  });

  it("defaults to the built-in view's own defaults", () => {
    const cfg = readLibraryViewConfig(fakeConfig({}));
    expect(cfg.cardSize).toBe(DEFAULT_CARD_SIZE);
    expect(cfg.imageAspectRatio).toBe(DEFAULT_ASPECT_RATIO);
    expect(cfg.imageFitContain).toBe(false);
    expect(cfg.imageProperty).toBe("note.cover");
  });

  it.each([null, undefined, 0, -5, "200", NaN, {}, true])(
    "falls back to the default card size for %s",
    (value) => {
      expect(readLibraryViewConfig(fakeConfig({ cardSize: value })).cardSize).toBe(DEFAULT_CARD_SIZE);
    },
  );

  it.each([null, undefined, 0, -1, "1.5", NaN])(
    "falls back to the default aspect ratio for %s",
    (value) => {
      expect(readLibraryViewConfig(fakeConfig({ imageAspectRatio: value })).imageAspectRatio).toBe(
        DEFAULT_ASPECT_RATIO,
      );
    },
  );

  it("binds the plugin's own overlay properties", () => {
    const cfg = readLibraryViewConfig(
      fakeConfig({ readStateProperty: "note.read-state", progressProperty: "note.progress" }),
    );
    expect(cfg.readStateProperty).toBe("note.read-state");
    expect(cfg.progressProperty).toBe("note.progress");
  });

  it("leaves overlay properties null when unbound", () => {
    const cfg = readLibraryViewConfig(fakeConfig({}));
    expect(cfg.readStateProperty).toBeNull();
    expect(cfg.progressProperty).toBeNull();
  });

  it("reads progressDisplay, defaulting to bar", () => {
    expect(readLibraryViewConfig(fakeConfig({ progressDisplay: "percent" })).progressDisplay).toBe("percent");
    expect(readLibraryViewConfig(fakeConfig({ progressDisplay: "nonsense" })).progressDisplay).toBe("bar");
    expect(readLibraryViewConfig(fakeConfig({})).progressDisplay).toBe("bar");
  });
});
