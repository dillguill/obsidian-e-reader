// The colour a painted highlight is drawn in.
//
// Both engines need this and neither can get it from styles.css: an EPUB's
// overlay lives inside epub.js's iframe, out of reach of the host document's
// stylesheet, and a PDF's boxes are positioned per-rect in JS. So the colour
// is resolved from the vault's own theme here and applied inline.
//
// A theme (or a snippet) can give a highlight type its own colour by defining
// `--ereader-hl-<type>`; otherwise every type uses Obsidian's own highlight
// colour, so a reader-configured type is never invisible.

const FALLBACK = "#ffd76e";

export function highlightColor(hostEl: HTMLElement | null, type: string): string {
  if (!hostEl) return FALLBACK;
  const style = hostEl.win.getComputedStyle(hostEl);
  const specific = style.getPropertyValue(`--ereader-hl-${type}`).trim();
  if (specific !== "") return specific;
  const shared = style.getPropertyValue("--text-highlight-bg").trim();
  return shared === "" ? FALLBACK : shared;
}
