// A whitespace-normalised view of some rendered text, with a way back.
//
// A highlight's authority is its quoted text (contracts/highlight-entry.md
// rule 3), and both the stored quote and the text it is matched against are
// whitespace-normalised (annotations/anchor.ts, normalizeQuote) — a PDF text
// layer emits one span per run and an EPUB paragraph is broken up by inline
// elements, so neither carries the source's own line breaks. That makes
// `resolveInText` able to find the quote, but its answer is an offset into
// the NORMALISED string, which lines up with nothing in the document.
//
// This module keeps the two in step: it builds the normalised string and,
// for every character in it, remembers which chunk of the original text that
// character came from and where. dom-selection.ts turns those back into a
// DOM Range; nothing here touches the DOM, so the collapsing rules are unit
// tested directly (tests/unit/text-index.test.ts).

/** One run of source text — a PDF text-layer span, or an EPUB text node. */
export interface TextChunk {
  text: string;
}

export interface ChunkPosition {
  /** Index into the chunk list this index was built from. */
  chunk: number;
  /** Character offset within that chunk's own (un-normalised) text. */
  offset: number;
}

export interface TextIndex {
  /** The chunks joined and whitespace-normalised. */
  text: string;
  /**
   * Where the character at `offset` in {@link text} came from. `offset` may
   * be `text.length`, giving the position just past the last character, so a
   * quote's end maps as readily as its start. Null outside that range.
   */
  locate(offset: number): ChunkPosition | null;
}

const WHITESPACE = /\s/;

export function buildTextIndex(chunks: readonly TextChunk[]): TextIndex {
  let text = "";
  /** positions[i] is the source of text[i]; always the same length as `text`. */
  const positions: ChunkPosition[] = [];
  /** Just past the last emitted character, so locate(text.length) can answer. */
  let end: ChunkPosition | null = null;
  /**
   * A run of whitespace becomes a single space, emitted lazily: only once a
   * non-whitespace character follows it, which is what drops trailing
   * whitespace without a separate trim pass. Its recorded position is the
   * first whitespace character of the run.
   */
  let pendingSpace: ChunkPosition | null = null;

  for (let chunk = 0; chunk < chunks.length; chunk++) {
    const raw = chunks[chunk]?.text ?? "";
    for (let offset = 0; offset < raw.length; offset++) {
      const character = raw[offset] as string;
      if (WHITESPACE.test(character)) {
        // Leading whitespace has nothing to separate, so it is simply dropped.
        if (text.length > 0 && pendingSpace === null) pendingSpace = { chunk, offset };
        continue;
      }
      if (pendingSpace !== null) {
        text += " ";
        positions.push(pendingSpace);
        pendingSpace = null;
      }
      text += character;
      positions.push({ chunk, offset });
      end = { chunk, offset: offset + 1 };
    }
  }

  return {
    text,
    locate(offset: number): ChunkPosition | null {
      if (!Number.isInteger(offset) || offset < 0) return null;
      if (offset < positions.length) return positions[offset] as ChunkPosition;
      if (offset === positions.length) return end;
      return null;
    },
  };
}
