// Reads the SAME config keys Obsidian's built-in Cards view reads, so a
// `.base` written for that view works here unchanged and the toolbar
// controls write back to the same fields.
//   image             property id supplying the cover
//   imageFit          "contain" | "cover"
//   imageAspectRatio  number > 0, height = width * ratio (default 1)
//   cardSize          column width in px (default 200)
// Plus this plugin's own progress binding, which drives both the bar and the
// badge derived from it.
import type { BasesPropertyId, BasesViewConfig } from "obsidian";

export const DEFAULT_CARD_SIZE = 200;
export const DEFAULT_ASPECT_RATIO = 1;

export interface LibraryViewConfig {
  imageProperty: BasesPropertyId | null;
  imageFitContain: boolean;
  imageAspectRatio: number;
  cardSize: number;
  /** Feeds BOTH overlays: the progress bar and the badge derived from it. */
  progressProperty: BasesPropertyId | null;
  progressDisplay: "bar" | "percent";
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Just the name the overlays care about, so this stays free of the settings module. */
export interface OverlayProperties {
  progress: string;
}

/** `note.<name>`, or null when the reader has cleared that property's name. */
function noteProperty(name: string): BasesPropertyId | null {
  return name.trim() === "" ? null : (`note.${name}` as BasesPropertyId);
}

/**
 * `properties` supplies the fallback binding for the overlays, so a plain
 * `.base` shows progress without the reader having to bind it by hand — the
 * same courtesy `image` already got. An explicit binding in the `.base` still
 * wins, since this is a default and not an override.
 */
export function readLibraryViewConfig(config: BasesViewConfig, properties: OverlayProperties): LibraryViewConfig {
  return {
    imageProperty: config.getAsPropertyId("image") ?? ("note.cover" as BasesPropertyId),
    imageFitContain: config.get("imageFit") === "contain",
    imageAspectRatio: positiveNumber(config.get("imageAspectRatio"), DEFAULT_ASPECT_RATIO),
    cardSize: positiveNumber(config.get("cardSize"), DEFAULT_CARD_SIZE),
    progressProperty: config.getAsPropertyId("progressProperty") ?? noteProperty(properties.progress),
    progressDisplay: config.get("progressDisplay") === "percent" ? "percent" : "bar",
  };
}
