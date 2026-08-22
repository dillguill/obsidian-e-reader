// Copies the layout rules pdf.js's own viewer needs out of pdfjs-dist and
// into styles.css, scoped to this plugin's container.
//
// The reader renders with pdf.js's PDFViewer, which lays pages out through
// ITS class names — `.pdfViewer`, `.page`, `.canvasWrapper`, `.textLayer`.
// Those names are global, and Obsidian's own PDF view uses an older pdf.js
// whose markup differs, so its `app.css` rules for them cannot be relied on
// and must not be disturbed either. Everything here is therefore nested
// inside one scoping class, which both isolates it from the built-in viewer
// and outranks the app's global rules where they overlap.
//
// Generated rather than hand-copied so a pdfjs-dist upgrade cannot leave the
// stylesheet describing markup the library no longer emits. Re-run with
// `npm run sync:pdf-css` and commit the result.

import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "node_modules/pdfjs-dist/web/pdf_viewer.css";
const TARGET = "styles.css";
const BEGIN = "/* === BEGIN generated from pdfjs-dist/web/pdf_viewer.css — `npm run sync:pdf-css` === */";
const END = "/* === END generated === */";
const SCOPE = ".ereader-pdf-host";

/** Layout and text-layer rules. Annotation and editor UI is disabled in the adapter. */
const KEEP = /^\s*(\.pdfViewer\b|\.page\b|\.canvasWrapper\b|\.textLayer\b|\.spread\b|\.dummyPage\b|\.hiddenCanvasElement\b)/;
const DROP = /editor|Editor|annotation|Annotation|comment|Comment|signature|Signature/;

function topLevelRules(css) {
  const rules = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) selector = css.slice(start, i);
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ selector, block: css.slice(start, i + 1).trim() });
        start = i + 1;
      }
    }
  }
  return rules;
}

const kept = topLevelRules(readFileSync(SOURCE, "utf8"))
  .filter(({ selector, block }) => selector.split(",").some((s) => KEEP.test(s)) && !DROP.test(selector) && !DROP.test(block))
  // The library's own asset URLs are relative to its web/ directory, which
  // is not shipped; leaving them in only produces failed requests.
  .map(({ block }) => block.replace(/url\((["']?)(?!data:)[^)]*\1\)/g, "none"))
  .map((block) =>
    block
      .split("\n")
      .map((line) => (line.trim() === "" ? "" : `  ${line}`))
      .join("\n"),
  );

// CSS nesting: a bare class inside the scope reads as a descendant of it.
const generated = [BEGIN, `${SCOPE} {`, ...kept, "}", END].join("\n");

const styles = readFileSync(TARGET, "utf8");
const from = styles.indexOf(BEGIN);
const to = styles.indexOf(END);
const next =
  from === -1 || to === -1
    ? `${styles.trimEnd()}\n\n${generated}\n`
    : `${styles.slice(0, from)}${generated}${styles.slice(to + END.length)}`;
writeFileSync(TARGET, next);

const bytes = new TextEncoder().encode(generated).length;
console.log(`sync-pdf-css: ${kept.length} rules, ${(bytes / 1024).toFixed(1)}KB, scoped to ${SCOPE}`);
