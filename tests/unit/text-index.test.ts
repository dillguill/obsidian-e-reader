import { describe, expect, it } from "vitest";
import { normalizeQuote } from "../../src/annotations/anchor";
import { buildTextIndex } from "../../src/reader/text-index";

const chunks = (...texts: string[]): { text: string }[] => texts.map((text) => ({ text }));

describe("buildTextIndex", () => {
  it("joins the chunks into one searchable string", () => {
    expect(buildTextIndex(chunks("Call me ", "Ishmael.")).text).toBe("Call me Ishmael.");
  });

  it("normalises whitespace exactly as the stored quote was normalised", () => {
    const raw = "  Call\n  me\t\tIshmael. ";
    expect(buildTextIndex(chunks(raw)).text).toBe(normalizeQuote(raw));
  });

  it("collapses whitespace that spans a chunk boundary into a single space", () => {
    // A PDF text layer emits one span per run; an EPUB paragraph is split by
    // inline elements. Either way the break between two chunks must read as
    // one space, not two.
    expect(buildTextIndex(chunks("Call me ", " Ishmael.")).text).toBe("Call me Ishmael.");
    expect(buildTextIndex(chunks("Call me\n", "\nIshmael.")).text).toBe("Call me Ishmael.");
  });

  it("drops chunks that are entirely whitespace without losing the separation", () => {
    expect(buildTextIndex(chunks("Call me", "   ", "Ishmael.")).text).toBe("Call me Ishmael.");
  });

  describe("locate", () => {
    it("maps an offset back to the chunk it came from", () => {
      const index = buildTextIndex(chunks("Call me ", "Ishmael."));
      expect(index.locate(0)).toEqual({ chunk: 0, offset: 0 });
      expect(index.locate(5)).toEqual({ chunk: 0, offset: 5 });
      expect(index.locate(8)).toEqual({ chunk: 1, offset: 0 });
    });

    it("accounts for whitespace the normalisation removed", () => {
      //  raw: "  Call   me"   normalised: "Call me"
      //        0123456789A                 0123456
      const index = buildTextIndex(chunks("  Call   me"));
      expect(index.locate(0)).toEqual({ chunk: 0, offset: 2 });
      expect(index.locate(5)).toEqual({ chunk: 0, offset: 9 });
    });

    it("maps the end-of-text offset to just past the last character", () => {
      const index = buildTextIndex(chunks("Call me"));
      expect(index.locate(7)).toEqual({ chunk: 0, offset: 7 });
    });

    it("returns null outside the text", () => {
      const index = buildTextIndex(chunks("Call me"));
      expect(index.locate(-1)).toBeNull();
      expect(index.locate(8)).toBeNull();
    });

    it("returns null for an empty index", () => {
      expect(buildTextIndex([]).text).toBe("");
      expect(buildTextIndex([]).locate(0)).toBeNull();
    });
  });

  it("round-trips a quote found by offset back to the right chunks", () => {
    const index = buildTextIndex(chunks("The quick ", "brown\n", "  fox jumps"));
    expect(index.text).toBe("The quick brown fox jumps");
    const at = index.text.indexOf("brown fox");
    const start = index.locate(at);
    const end = index.locate(at + "brown fox".length);
    expect(start).toEqual({ chunk: 1, offset: 0 });
    expect(end).toEqual({ chunk: 2, offset: 5 });
  });
});
