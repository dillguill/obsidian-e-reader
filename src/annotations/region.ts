// The plugin's own region inside a book note. Everything outside the
// `%%e-reader:begin%%` / `%%e-reader:end%%` markers belongs to the reader and
// must never be modified (contract rule 1, FR-037b) — including the heading
// above the region once it exists, which the reader is free to rename.
//
// Pure string operations, so the "never touches the rest of the note"
// guarantee is directly testable without a vault.

export const REGION_BEGIN = "%%e-reader:begin%%";
export const REGION_END = "%%e-reader:end%%";
export const DEFAULT_REGION_HEADING = "## Highlights";

export interface Region {
  /** Everything between the markers, exclusive of them and of their newlines. */
  body: string;
  /** Offset of the first character of the begin marker. */
  start: number;
  /** Offset just past the last character of the end marker. */
  end: number;
}

export function findRegion(noteText: string): Region | null {
  const start = noteText.indexOf(REGION_BEGIN);
  if (start === -1) return null;
  const bodyStart = start + REGION_BEGIN.length;
  const bodyEnd = noteText.indexOf(REGION_END, bodyStart);
  if (bodyEnd === -1) return null;
  return {
    body: noteText.slice(bodyStart, bodyEnd).replace(/^\n+/, "").replace(/\s+$/, ""),
    start,
    end: bodyEnd + REGION_END.length,
  };
}

/**
 * Returns `noteText` with the region's body replaced by `body`, creating the
 * region (under `heading`) at the end of the note if it does not exist yet.
 * The text before the begin marker and after the end marker is returned
 * byte-for-byte unchanged.
 */
export function writeRegion(noteText: string, body: string, heading = DEFAULT_REGION_HEADING): string {
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  const block = trimmedBody === "" ? `${REGION_BEGIN}\n\n${REGION_END}` : `${REGION_BEGIN}\n\n${trimmedBody}\n\n${REGION_END}`;

  const region = findRegion(noteText);
  if (region) {
    return noteText.slice(0, region.start) + block + noteText.slice(region.end);
  }

  const before = noteText.replace(/\s+$/, "");
  const separator = before === "" ? "" : "\n\n";
  return `${before}${separator}${heading}\n${block}\n`;
}
