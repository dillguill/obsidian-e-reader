import { describe, expect, it } from "vitest";
import { isSpreadMode } from "../../src/reader/spread";

describe("isSpreadMode", () => {
  it("accepts the three modes", () => {
    expect(isSpreadMode("single")).toBe(true);
    expect(isSpreadMode("odd")).toBe(true);
    expect(isSpreadMode("even")).toBe(true);
  });

  it("rejects anything else, so a corrupt data.json falls back to a default", () => {
    expect(isSpreadMode("double")).toBe(false);
    expect(isSpreadMode(2)).toBe(false);
    expect(isSpreadMode(null)).toBe(false);
  });
});
