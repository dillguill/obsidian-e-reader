// Whether a note is a Book note.
//
// The marker property (default `type: book`) has been configurable since the
// settings existed, and until now nothing consulted it: the reader treated
// ANY markdown file it could resolve an attachment from as a book note, and
// wrote reading progress into it. This is the check that keeps the plugin's
// writes inside notes the reader has actually marked as books.
//
// Pure, so the awkward shapes — a list of types, a numeric value, a cleared
// setting — are covered without a vault (tests/unit/book-note.test.ts).

/** Every value under `key`, as text: frontmatter holds a scalar or a list. */
function valuesAt(frontmatter: Record<string, unknown>, key: string): string[] {
  const raw = frontmatter[key];
  const items = Array.isArray(raw) ? raw : [raw];
  return items
    .filter((item): item is string | number | boolean => item !== null && item !== undefined && typeof item !== "object")
    .map((item) => String(item).trim())
    .filter((item) => item !== "");
}

/**
 * True when `frontmatter` marks the note as a book.
 *
 * Clearing either setting is how a reader opts out: a blank marker NAME means
 * no requirement at all, and a blank marker VALUE means any value under that
 * property will do. Neither should lock someone out of their own notes.
 */
export function isBookNote(
  frontmatter: Record<string, unknown> | null | undefined,
  marker: string,
  markerValue: string,
): boolean {
  if (marker.trim() === "") return true;
  if (!frontmatter) return false;
  const values = valuesAt(frontmatter, marker);
  if (values.length === 0) return false;
  const wanted = markerValue.trim().toLowerCase();
  if (wanted === "") return true;
  return values.some((value) => value.toLowerCase() === wanted);
}
