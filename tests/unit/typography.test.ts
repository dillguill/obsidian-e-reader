import { describe, expect, it } from "vitest";
import {
  LINE_SPACINGS,
  MARGINS,
  type Typography,
  isBookFont,
  isLineSpacing,
  isMargins,
  isReadingTheme,
  lineHeightFor,
  marginPadding,
  typographyCss,
} from "../../src/reader/typography";

const DEFAULTS: Typography = { font: "book", lineSpacing: "normal", margins: "normal", justify: false, hyphenate: false };

describe("typographyCss", () => {
  it("sets only the vault font on body by default, as the reader always did", () => {
    expect(typographyCss(DEFAULTS, "Inter")).toBe("body { font-family: Inter; }");
  });

  it("forces a chosen font onto the text but leaves code alone", () => {
    const css = typographyCss({ ...DEFAULTS, font: "serif" }, "Inter");
    expect(css).toContain("serif !important");
    expect(css).toContain(":not(pre)");
    expect(css).not.toContain("Inter");
  });

  it("forces a line height onto the blocks themselves, since books set it on `p`", () => {
    const css = typographyCss({ ...DEFAULTS, lineSpacing: "relaxed" }, "Inter");
    expect(css).toContain("p, li");
    expect(css).toContain("line-height: 1.8 !important");
    expect(lineHeightFor("normal")).toBeNull();
    expect(lineHeightFor("compact")).toBeLessThan(lineHeightFor("relaxed") ?? 0);
  });

  it("justifies and hyphenates only when asked", () => {
    expect(typographyCss(DEFAULTS, "Inter")).not.toContain("justify");
    const css = typographyCss({ ...DEFAULTS, justify: true, hyphenate: true }, "Inter");
    expect(css).toContain("text-align: justify !important");
    expect(css).toContain("hyphens: auto !important");
  });
});

describe("margins", () => {
  it("adds nothing at normal, so the book keeps the full width it had", () => {
    expect(marginPadding("normal")).toBe("");
  });

  it("grows from wide to extra wide", () => {
    expect(marginPadding("wide")).toMatch(/^clamp\(/);
    expect(marginPadding("extra-wide")).not.toBe(marginPadding("wide"));
  });
});

describe("guards", () => {
  it("recognise only their own values", () => {
    for (const value of LINE_SPACINGS) expect(isLineSpacing(value)).toBe(true);
    for (const value of MARGINS) expect(isMargins(value)).toBe(true);
    expect(isLineSpacing("double")).toBe(false);
    expect(isMargins("huge")).toBe(false);
    expect(isBookFont("serif")).toBe(true);
    expect(isBookFont("comic")).toBe(false);
    expect(isReadingTheme("sepia")).toBe(true);
    expect(isReadingTheme(undefined)).toBe(false);
  });
});
