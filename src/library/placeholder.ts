// A cover for a book that has none, so the grid never shows an empty grey box.
// The colour comes from the title, so a book keeps the same cover across
// renders and neighbouring books rarely match.

/** A hue (0-359) that is stable for a given title. */
export function placeholderHue(title: string): number {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/** The title as it should be printed on a placeholder: a file name without its clutter. */
export function placeholderTitle(basename: string): string {
  return basename.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}
