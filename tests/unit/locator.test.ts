import { describe, it, expect } from "vitest";
import { parseLocator, serializeLocator, compareLocators } from "../../src/core/locator";
import type { Locator } from "../../src/core/types";

describe("serializeLocator", () => {
  it("serialises an EPUB locator to its raw CFI string", () => {
    const locator: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" };
    expect(serializeLocator(locator)).toBe("epubcfi(/6/4!/4/2/2[ch01]/2/1:0)");
  });

  it("serialises a PDF locator with an offset", () => {
    const locator: Locator = { kind: "pdf", page: 42, offset: 118 };
    expect(serializeLocator(locator)).toBe("page=42&offset=118");
  });

  it("serialises a PDF locator without an offset", () => {
    const locator: Locator = { kind: "pdf", page: 42 };
    expect(serializeLocator(locator)).toBe("page=42");
  });
});

describe("parseLocator round-trips", () => {
  it("round-trips an EPUB CFI exactly", () => {
    const raw = "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)";
    const parsed = parseLocator(raw);
    expect(parsed).toEqual({ kind: "epub", cfi: raw });
    expect(serializeLocator(parsed!)).toBe(raw);
  });

  it("round-trips a PDF locator with an offset", () => {
    const raw = "page=42&offset=118";
    const parsed = parseLocator(raw);
    expect(parsed).toEqual({ kind: "pdf", page: 42, offset: 118 });
    expect(serializeLocator(parsed!)).toBe(raw);
  });

  it("round-trips a PDF locator without an offset", () => {
    const raw = "page=1";
    const parsed = parseLocator(raw);
    expect(parsed).toEqual({ kind: "pdf", page: 1 });
    expect(serializeLocator(parsed!)).toBe(raw);
  });
});

describe("parseLocator malformed input", () => {
  it.each([
    ["empty string", ""],
    ["garbage", "not-a-locator"],
    ["non-numeric page", "page=abc"],
    ["negative page", "page=-5"],
    ["CFI missing its closing paren", "epubcfi(/6/4!/4/2/2[ch01]/2/1:0"],
    ["page=0 (pages are 1-based)", "page=0"],
  ])("returns null for %s", (_label, input) => {
    expect(parseLocator(input)).toBeNull();
  });
});

describe("compareLocators", () => {
  it("returns null for mixed-kind locators", () => {
    const epub: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" };
    const pdf: Locator = { kind: "pdf", page: 1 };
    expect(compareLocators(epub, pdf)).toBeNull();
    expect(compareLocators(pdf, epub)).toBeNull();
  });

  describe("PDF locators", () => {
    it("orders by page first", () => {
      const a: Locator = { kind: "pdf", page: 1 };
      const b: Locator = { kind: "pdf", page: 2 };
      expect(compareLocators(a, b)).toBe(-1);
      expect(compareLocators(b, a)).toBe(1);
    });

    it("orders by offset when pages match", () => {
      const a: Locator = { kind: "pdf", page: 5, offset: 10 };
      const b: Locator = { kind: "pdf", page: 5, offset: 50 };
      expect(compareLocators(a, b)).toBe(-1);
      expect(compareLocators(b, a)).toBe(1);
    });

    it("treats a missing offset as before any defined offset on the same page", () => {
      const a: Locator = { kind: "pdf", page: 5 };
      const b: Locator = { kind: "pdf", page: 5, offset: 1 };
      expect(compareLocators(a, b)).toBe(-1);
    });

    it("returns 0 for identical locators", () => {
      const a: Locator = { kind: "pdf", page: 5, offset: 10 };
      const b: Locator = { kind: "pdf", page: 5, offset: 10 };
      expect(compareLocators(a, b)).toBe(0);
    });
  });

  describe("EPUB locators", () => {
    it("orders by a later step in the CFI path", () => {
      const a: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" };
      const b: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/5:0)" };
      expect(compareLocators(a, b)).toBe(-1);
      expect(compareLocators(b, a)).toBe(1);
    });

    it("orders by character offset when the path is otherwise identical", () => {
      const a: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" };
      const b: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:50)" };
      expect(compareLocators(a, b)).toBe(-1);
      expect(compareLocators(b, a)).toBe(1);
    });

    it("treats a shorter path as earlier than one that extends it", () => {
      const shorter: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2)" };
      const longer: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" };
      expect(compareLocators(shorter, longer)).toBe(-1);
      expect(compareLocators(longer, shorter)).toBe(1);
    });

    it("returns 0 for identical CFIs", () => {
      const a: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" };
      const b: Locator = { kind: "epub", cfi: "epubcfi(/6/4!/4/2/2[ch01]/2/1:0)" };
      expect(compareLocators(a, b)).toBe(0);
    });
  });
});
