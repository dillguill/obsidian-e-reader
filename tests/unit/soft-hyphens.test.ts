import { describe, expect, it } from "vitest";
import { canHyphenate, hyphenateText, stripSoftHyphens } from "../../src/reader/soft-hyphens";
import { normalizeQuote } from "../../src/annotations/anchor";
import { buildTextIndex } from "../../src/reader/text-index";

describe("soft hyphens", () => {
  it("marks English break points, and strips them again", () => {
    const text = "an unbearable frenzy";
    const hyphenated = hyphenateText(text);
    expect(hyphenated.replace(/­/g, "-")).toBe("an un-bear-able fren-zy");
    expect(stripSoftHyphens(hyphenated)).toBe(text);
  });

  it("only claims English", () => {
    expect(canHyphenate("en")).toBe(true);
    expect(canHyphenate("en-GB")).toBe(true);
    expect(canHyphenate("fr")).toBe(false);
    expect(canHyphenate(null)).toBe(false);
  });

  it("is invisible to quotes and the text index", () => {
    const hyphenated = hyphenateText("an unbearable frenzy");
    expect(normalizeQuote(hyphenated)).toBe("an unbearable frenzy");
    const index = buildTextIndex([{ text: hyphenated }]);
    expect(index.text).toBe("an unbearable frenzy");
    // "frenzy" maps back past the soft hyphens before it.
    const at = index.text.indexOf("frenzy");
    expect(hyphenated.slice(index.locate(at)?.offset)).toMatch(/^fren/);
  });
});
