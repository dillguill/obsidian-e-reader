import { describe, expect, it } from "vitest";
import { contextAround, normalizeQuote, resolveInText } from "../../src/annotations/anchor";
import { parseEntry, serializeEntry, type Entry } from "../../src/annotations/entry";
import { REGION_BEGIN, REGION_END, findRegion, writeRegion } from "../../src/annotations/region";

const entry: Entry = {
  id: "h-a1b2c3",
  type: "idea",
  exact: "the spice must flow",
  comment: "Worth comparing to the guild's monopoly argument.",
  anchor: {
    id: "h-a1b2c3",
    prefix: "He said that ",
    suffix: " and then left.",
    hint: { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" },
    created: "2026-08-20T10:04:00Z",
  },
};

describe("anchor", () => {
  it("captures 32 characters either side by default", () => {
    const text = `${"a".repeat(50)}QUOTE${"b".repeat(50)}`;
    const context = contextAround(text, 50, 55);
    expect(context.prefix).toBe("a".repeat(32));
    expect(context.suffix).toBe("b".repeat(32));
  });

  it("clamps a range that runs past the end of the text", () => {
    expect(contextAround("short", 3, 999)).toEqual({ prefix: "sho", suffix: "" });
  });

  it("collapses the whitespace a cross-line selection introduces", () => {
    expect(normalizeQuote("  the spice\n  must   flow \n")).toBe("the spice must flow");
  });

  it("resolves a unique quote without needing context", () => {
    expect(resolveInText("one two three", "two")).toBe(4);
  });

  it("disambiguates a repeated quote by its recorded context", () => {
    const text = "alpha SAME omega ... beta SAME gamma";
    expect(resolveInText(text, "SAME", { prefix: "beta ", suffix: " gamma" })).toBe(26);
  });

  it("reports a still-ambiguous quote as unanchored rather than guessing", () => {
    const text = "x SAME y x SAME y";
    expect(resolveInText(text, "SAME", { prefix: "x ", suffix: " y" })).toBeNull();
  });

  it("reports a missing quote as unanchored", () => {
    expect(resolveInText("nothing here", "absent")).toBeNull();
  });
});

describe("entry", () => {
  it("round-trips through the contract's format", () => {
    const markdown = serializeEntry(entry);
    const blockquote = markdown.split("\n\n^")[0] as string;
    const parsed = parseEntry(blockquote, entry.id);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.entry).toEqual(entry);
  });

  it("places the block identifier on its own line after a blank line", () => {
    expect(serializeEntry(entry)).toMatch(/\n\n\^h-a1b2c3\n$/);
  });

  it("escapes percent signs so captured context cannot close the comment", () => {
    const risky: Entry = { ...entry, anchor: { ...entry.anchor, suffix: "100%% sure" } };
    const markdown = serializeEntry(risky);
    expect(markdown).not.toContain("100%% sure");
    const parsed = parseEntry(markdown.split("\n\n^")[0] as string, risky.id);
    expect(parsed.ok && parsed.entry.anchor.suffix).toBe("100%% sure");
  });

  it("round-trips a quote that itself contains highlight markers", () => {
    const nested: Entry = { ...entry, exact: "a == b" };
    const parsed = parseEntry(serializeEntry(nested).split("\n\n^")[0] as string, nested.id);
    expect(parsed.ok && parsed.entry.exact).toBe("a == b");
  });

  it("serialises a bookmark with no quote", () => {
    const bookmark: Entry = { ...entry, type: "bookmark", exact: "", comment: "" };
    expect(serializeEntry(bookmark)).not.toContain("==");
    const parsed = parseEntry(serializeEntry(bookmark).split("\n\n^")[0] as string, bookmark.id);
    expect(parsed.ok && parsed.entry.exact).toBe("");
  });

  it("reports a malformed entry with its text intact instead of rewriting it", () => {
    const raw = "> [!quote] idea\n> ==orphaned quote==";
    const parsed = parseEntry(raw, "h-broken");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.malformed.raw).toBe(raw);
      expect(parsed.malformed.id).toBe("h-broken");
      expect(parsed.malformed.reason).toContain("anchor record");
    }
  });

  it("rejects an entry whose block identifier disagrees with its anchor", () => {
    const parsed = parseEntry(serializeEntry(entry).split("\n\n^")[0] as string, "h-different");
    expect(parsed.ok).toBe(false);
  });
});

describe("region", () => {
  const note = `---\ntype: book\n---\n\nMy own notes, untouched.\n\n## Highlights\n${REGION_BEGIN}\n\nOLD BODY\n\n${REGION_END}\n`;

  it("finds the body between the markers", () => {
    expect(findRegion(note)?.body).toBe("OLD BODY");
  });

  it("leaves everything outside the markers byte-for-byte unchanged", () => {
    const updated = writeRegion(note, "NEW BODY");
    const before = note.slice(0, note.indexOf(REGION_BEGIN));
    const after = note.slice(note.indexOf(REGION_END) + REGION_END.length);
    expect(updated.startsWith(before)).toBe(true);
    expect(updated.endsWith(after)).toBe(true);
    expect(updated).toContain("NEW BODY");
    expect(updated).not.toContain("OLD BODY");
  });

  it("creates the region at the end of a note that has none", () => {
    const plain = "---\ntype: book\n---\n\nJust prose.\n";
    const updated = writeRegion(plain, "ENTRY");
    expect(updated.startsWith("---\ntype: book\n---\n\nJust prose.")).toBe(true);
    expect(updated).toContain("## Highlights");
    expect(findRegion(updated)?.body).toBe("ENTRY");
  });

  it("keeps an empty region rather than deleting it when the last entry goes", () => {
    const updated = writeRegion(note, "");
    expect(findRegion(updated)?.body).toBe("");
    expect(updated).toContain("My own notes, untouched.");
  });
});
