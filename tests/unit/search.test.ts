import { describe, expect, it } from "vitest";
import { findMatches, hitFromText } from "../../src/reader/search";

describe("findMatches", () => {
  it("ignores case", () => {
    expect(findMatches("The cat saw the Cat.", "cat")).toEqual([
      { start: 4, end: 7 },
      { start: 16, end: 19 },
    ]);
  });

  it("treats whitespace in the query as one space, as the text already is", () => {
    expect(findMatches("a long  way", "long \n way")).toEqual([]);
    expect(findMatches("a long way", "long \n way")).toEqual([{ start: 2, end: 10 }]);
  });

  it("finds nothing for an empty query", () => {
    expect(findMatches("anything", "   ")).toEqual([]);
  });

  it("does not overlap matches", () => {
    expect(findMatches("aaaa", "aa")).toHaveLength(2);
  });
});

describe("hitFromText", () => {
  const text = "It was the best of times, it was the worst of times, it was the age of wisdom.";

  it("keeps the book's own capitalisation for the matched text", () => {
    const [match] = findMatches(text, "it was");
    const hit = hitFromText(text, match!, { kind: "pdf", page: 3 });
    expect(hit.exact).toBe("It was");
    expect(hit.before).toBe("");
    expect(hit.locator).toEqual({ kind: "pdf", page: 3 });
  });

  it("carries enough context to tell repeated matches apart", () => {
    const matches = findMatches(text, "it was");
    const second = hitFromText(text, matches[1]!, { kind: "pdf", page: 3 });
    expect(second.prefix.endsWith("best of times,")).toBe(true);
    expect(second.suffix.startsWith("the worst")).toBe(true);
  });

  it("marks a cut excerpt and cuts it on a word boundary", () => {
    const long = `${"word ".repeat(40)}needle${" word".repeat(40)}`;
    const [match] = findMatches(long, "needle");
    const hit = hitFromText(long, match!, { kind: "pdf", page: 1 });
    expect(hit.before.startsWith("…word")).toBe(true);
    expect(hit.after.endsWith("word…")).toBe(true);
  });
});
