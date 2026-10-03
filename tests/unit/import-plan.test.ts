import { describe, expect, it } from "vitest";
import { coverExtension, fillGaps } from "../../src/import/metadata";
import { matchFromSearch, searchUrl } from "../../src/import/open-library";
import { buildFrontmatter, duplicateKeys, isInFolder, joinPath, normalizeForMatch, safeFileName } from "../../src/import/plan";

const NAMES = { marker: "type", markerValue: "book", cover: "cover", attachments: "attachments" };

describe("safeFileName", () => {
  it("replaces characters that cannot appear in a file name or a link", () => {
    expect(safeFileName('What: A "Story" / Part [1]?')).toBe("What A Story Part 1");
  });

  it("drops leading and trailing dots", () => {
    expect(safeFileName("...Hidden. ")).toBe("Hidden");
  });

  it("names an empty title", () => {
    expect(safeFileName(" :: ")).toBe("Untitled book");
  });

  it("caps very long titles", () => {
    expect(safeFileName("a".repeat(300)).length).toBe(120);
  });
});

describe("duplicate matching", () => {
  it("ignores case, accents, punctuation and a leading article", () => {
    expect(normalizeForMatch("The Café: A Story!")).toBe(normalizeForMatch("cafe a story"));
  });

  it("keys on ISBN and on title with first author", () => {
    expect(duplicateKeys({ title: "Dune", authors: ["Frank Herbert"], isbn: "9780441172719" })).toEqual([
      "isbn:9780441172719",
      "book:dune|frank herbert",
    ]);
  });
});

describe("buildFrontmatter", () => {
  it("writes the marker, links and every known field, leaving out what is empty", () => {
    const fm = buildFrontmatter(
      { title: "Dune", authors: ["Frank Herbert"], subjects: ["SF"], pages: 412, isbn: "123" },
      NAMES,
      { book: "[[Dune.epub]]", cover: "[[Dune cover.jpg]]" },
    );
    expect(fm).toEqual({
      type: "book",
      title: "Dune",
      author: ["Frank Herbert"],
      cover: "[[Dune cover.jpg]]",
      attachments: ["[[Dune.epub]]"],
      isbn: "123",
      pages: 412,
      topics: ["SF"],
    });
  });

  it("uses the configured property names and skips a cleared marker", () => {
    const fm = buildFrontmatter({ title: "X", authors: [], subjects: [] }, { ...NAMES, marker: "", attachments: "files" }, {
      book: "[[X.pdf]]",
      cover: null,
    });
    expect(fm).toEqual({ title: "X", files: ["[[X.pdf]]"] });
  });
});

describe("paths", () => {
  it("joins onto a folder or the vault root", () => {
    expect(joinPath("Library/", "a.md")).toBe("Library/a.md");
    expect(joinPath("", "a.md")).toBe("a.md");
  });

  it("knows what sits inside a folder, and that an empty folder holds nothing", () => {
    expect(isInFolder("Inbox/sub/a.epub", "Inbox")).toBe(true);
    expect(isInFolder("Inboxes/a.epub", "Inbox")).toBe(false);
    expect(isInFolder("a.epub", "")).toBe(false);
  });
});

describe("metadata helpers", () => {
  it("fills only the gaps", () => {
    const merged = fillGaps({ title: "Dune", authors: ["Frank Herbert"], subjects: [] }, {
      authors: ["Someone Else"],
      subjects: ["SF"],
      pages: 412,
    });
    expect(merged).toEqual({ title: "Dune", authors: ["Frank Herbert"], subjects: ["SF"], pages: 412 });
  });

  it("maps cover media types and falls back to the file extension", () => {
    expect(coverExtension("image/jpeg")).toBe("jpg");
    expect(coverExtension(undefined, "c.PNG")).toBe("png");
    expect(coverExtension("image/svg+xml", "c.svg")).toBeNull();
  });
});

describe("Open Library", () => {
  it("searches by ISBN when there is one, else by title and author", () => {
    expect(searchUrl({ title: "Dune", authors: [], isbn: "123" })).toContain("isbn=123");
    const url = searchUrl({ title: "Dune", authors: ["Frank Herbert"] });
    expect(url).toContain("title=Dune");
    expect(url).toContain("author=Frank+Herbert");
  });

  const response = {
    docs: [
      {
        title: "Dune",
        author_name: ["Frank Herbert"],
        isbn: ["0441172717", "9780441172719"],
        number_of_pages_median: 412,
        subject: ["a", "b", "c", "d", "e", "f"],
        first_publish_year: 1965,
        cover_i: 42,
      },
    ],
  };

  it("maps a matching result to the fields it can fill", () => {
    const match = matchFromSearch(response, { title: "Dune" });
    expect(match?.fields).toMatchObject({
      authors: ["Frank Herbert"],
      isbn: "9780441172719",
      pages: 412,
      published: "1965",
      subjects: ["a", "b", "c", "d", "e"],
    });
    expect(match?.coverUrl).toContain("/b/id/42-L.jpg");
  });

  it("rejects a title search that found a different book", () => {
    expect(matchFromSearch(response, { title: "Emma" })).toBeNull();
  });

  it("trusts an ISBN search whatever the title", () => {
    expect(matchFromSearch(response, { title: "Dune (Special Edition)", isbn: "9780441172719" })).not.toBeNull();
  });

  it("returns null for an empty or malformed response", () => {
    expect(matchFromSearch({ docs: [] }, { title: "Dune" })).toBeNull();
    expect(matchFromSearch(null, { title: "Dune" })).toBeNull();
  });
});
