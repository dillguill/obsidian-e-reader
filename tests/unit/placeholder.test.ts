import { describe, expect, it } from "vitest";
import { placeholderHue, placeholderTitle } from "../../src/library/placeholder";

describe("placeholderHue", () => {
  it("is stable for a title", () => {
    expect(placeholderHue("Dune")).toBe(placeholderHue("Dune"));
  });

  it("stays within the colour wheel", () => {
    for (const title of ["", "a", "Dune", "The Left Hand of Darkness", "😀 emoji"]) {
      const hue = placeholderHue(title);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("varies between titles", () => {
    const hues = new Set(["Dune", "Emma", "Ulysses", "Middlemarch", "Beloved"].map(placeholderHue));
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe("placeholderTitle", () => {
  it("turns underscores into spaces and collapses runs", () => {
    expect(placeholderTitle("the_left__hand  of darkness ")).toBe("the left hand of darkness");
  });
});
