import { describe, expect, it } from "vitest";
import {
  LINE_SPACINGS,
  MARGINS,
  isLineSpacing,
  isMargins,
  lineHeightFor,
  lineSpacingCss,
  marginPadding,
} from "../../src/reader/typography";

describe("line spacing", () => {
  it("leaves the book's own spacing alone at normal", () => {
    expect(lineHeightFor("normal")).toBeNull();
    expect(lineSpacingCss("normal")).toBe("");
  });

  it("forces a height onto block elements otherwise, since books set it on `p`", () => {
    expect(lineSpacingCss("relaxed")).toContain("p,");
    expect(lineSpacingCss("relaxed")).toContain("line-height: 1.8 !important");
    expect(lineHeightFor("compact")).toBeLessThan(lineHeightFor("relaxed") ?? 0);
  });

  it("recognises only its own values", () => {
    for (const value of LINE_SPACINGS) expect(isLineSpacing(value)).toBe(true);
    expect(isLineSpacing("double")).toBe(false);
    expect(isLineSpacing(undefined)).toBe(false);
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

  it("recognises only its own values", () => {
    for (const value of MARGINS) expect(isMargins(value)).toBe(true);
    expect(isMargins("huge")).toBe(false);
  });
});
