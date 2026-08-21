// The colour a highlight of a given type is painted in.
//
// Neither engine can get this from styles.css: an EPUB's overlay lives inside
// epub.js's iframe, out of reach of the host document's stylesheet, and a
// PDF's boxes are positioned per-rect in JS. So the reader resolves the
// colour here, from the types the reader configured, and hands each engine a
// concrete value on the PaintedHighlight itself.

import type { AnnotationType } from "../settings/settings-model";

/** Used by a highlight whose type has since been deleted from the settings. */
export const ORPHAN_HIGHLIGHT_COLOR = "#c0c0c0";

export function highlightColor(types: readonly AnnotationType[], type: string): string {
  return types.find((candidate) => candidate.name === type)?.color ?? ORPHAN_HIGHLIGHT_COLOR;
}
