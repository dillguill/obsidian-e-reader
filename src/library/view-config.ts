// Reads the SAME config keys Obsidian's built-in Cards view reads, so a
// `.base` written for that view works here unchanged and the toolbar
// controls write back to the same fields.
//   image             property id supplying the cover
//   imageFit          "contain" | "cover"
//   imageAspectRatio  number > 0, height = width * ratio (default 1)
//   cardSize          column width in px (default 200)
// Plus this plugin's own two overlay bindings.
import type { BasesPropertyId, BasesViewConfig } from "obsidian";

export const DEFAULT_CARD_SIZE = 200;
export const DEFAULT_ASPECT_RATIO = 1;

export interface LibraryViewConfig {
  imageProperty: BasesPropertyId | null;
  imageFitContain: boolean;
  imageAspectRatio: number;
  cardSize: number;
  readStateProperty: BasesPropertyId | null;
  progressProperty: BasesPropertyId | null;
  progressDisplay: "bar" | "percent";
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readLibraryViewConfig(config: BasesViewConfig): LibraryViewConfig {
  return {
    imageProperty: config.getAsPropertyId("image") ?? ("note.cover" as BasesPropertyId),
    imageFitContain: config.get("imageFit") === "contain",
    imageAspectRatio: positiveNumber(config.get("imageAspectRatio"), DEFAULT_ASPECT_RATIO),
    cardSize: positiveNumber(config.get("cardSize"), DEFAULT_CARD_SIZE),
    readStateProperty: config.getAsPropertyId("readStateProperty"),
    progressProperty: config.getAsPropertyId("progressProperty"),
    progressDisplay: config.get("progressDisplay") === "percent" ? "percent" : "bar",
  };
}
