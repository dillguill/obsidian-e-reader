import { describe, it, expect } from "vitest";
import { applyStatus, hasStatus, normalizeStatus, readStatusList, withStatus } from "../../src/core/status";

const tags = { useTags: true, property: "shelves", readLater: "read-later", wishlist: "wishlist" };
const list = { useTags: false, property: "shelves", readLater: "Read later", wishlist: "Wishlist" };

describe("status list", () => {
  it("reads a list, a comma-separated string, or nothing", () => {
    expect(readStatusList(["a", " b ", "", 3])).toEqual(["a", "b", "3"]);
    expect(readStatusList("a, b")).toEqual(["a", "b"]);
    expect(readStatusList(null)).toEqual([]);
  });

  it("matches ignoring case and a tag's #", () => {
    expect(hasStatus(["#Read-Later"], "read-later")).toBe(true);
    expect(hasStatus(["wishlist"], "read-later")).toBe(false);
    expect(hasStatus(["x"], "")).toBe(false);
  });

  it("adds a status once and keeps the other entries as written", () => {
    expect(withStatus(["fiction", "#Read-Later"], "read-later", true)).toEqual(["fiction", "read-later"]);
    expect(withStatus("fiction", "wishlist", true)).toEqual(["fiction", "wishlist"]);
  });

  it("removes the property when the last entry goes", () => {
    expect(withStatus(["wishlist"], "wishlist", false)).toBeNull();
    expect(withStatus(["fiction", "wishlist"], "wishlist", false)).toEqual(["fiction"]);
  });

  it("normalizes tag values but leaves list values alone", () => {
    expect(normalizeStatus(" #read later ", true)).toBe("read-later");
    expect(normalizeStatus(" Read later ", false)).toBe("Read later");
  });

  it("writes to tags or to the chosen property", () => {
    const a: Record<string, unknown> = { tags: ["fiction"] };
    applyStatus(a, tags, tags.readLater, true);
    expect(a).toEqual({ tags: ["fiction", "read-later"] });

    const b: Record<string, unknown> = { status: "reading", shelves: ["Wishlist"] };
    applyStatus(b, list, list.wishlist, false);
    expect(b).toEqual({ status: "reading" });
  });
});
