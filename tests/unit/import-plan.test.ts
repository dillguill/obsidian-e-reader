import { describe, expect, it } from "vitest";
import { coverExtension, fillGaps } from "../../src/import/metadata";
import { matchFromSearch, querySearchUrl, resultsFromSearch, searchUrl } from "../../src/import/open-library";
import { bookIdentity, buildFrontmatter, isInFolder, joinPath, normalizeForMatch, normalizeIsbn, safeFileName, sameBook, groupDuplicates } from "../../src/import/plan";

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

  const id = (title: string, author?: string, isbn?: string) =>
    bookIdentity({ title, authors: author ? [author] : [], isbn });

  it("matches one ISBN however it is written", () => {
    expect(normalizeIsbn("0-441-17271-7")).toBe("9780441172719");
    expect(normalizeIsbn("978-0-441-17271-9")).toBe("9780441172719");
    expect(sameBook(id("Dune", "", "0441172717"), id("Something else", "", "9780441172719"))).toBe(true);
  });

  it("matches a title with or without its subtitle, and an author in either order", () => {
    expect(sameBook(id("Dune: Deluxe Edition", "Frank Herbert"), id("Dune", "Herbert, Frank"))).toBe(true);
    expect(sameBook(id("Emma (Penguin Classics)", "J. Austen"), id("Emma", "Jane Austen"))).toBe(true);
  });

  it("matches a note with no author by title alone", () => {
    expect(sameBook(id("Dune"), id("Dune", "Frank Herbert", "9780441172719"))).toBe(true);
  });

  it("groups the books that appear more than once", () => {
    const books = [
      { name: "a", id: id("Dune", "Frank Herbert") },
      { name: "b", id: id("Dune: Deluxe", "") },
      { name: "c", id: id("Emma", "Jane Austen", "0441172717") },
      { name: "d", id: id("Other", "", "9780441172719") },
      { name: "e", id: id("Piranesi", "Susanna Clarke") },
    ];
    const groups = groupDuplicates(books, (book) => book.id).map((group) => group.map((book) => book.name).sort());
    expect(groups.sort()).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("does not match a different author or title", () => {
    expect(sameBook(id("Emma", "Jane Austen"), id("Emma", "Someone Else"))).toBe(false);
    expect(sameBook(id("Dune", "Frank Herbert"), id("Dune Messiah", "Frank Herbert"))).toBe(false);
  });
});

describe("buildFrontmatter", () => {
  it("leaves attachments out for a book with no file yet", () => {
    const fm = buildFrontmatter(
      { title: "T", authors: [], subjects: [] },
      { marker: "type", markerValue: "book", cover: "cover", attachments: "attachments" },
      { book: null, cover: null },
    );
    expect(fm).not.toHaveProperty("attachments");
  });

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

describe("wishlist search", () => {
  it("searches a bare ISBN as an ISBN and anything else as free text", () => {
    expect(new URL(querySearchUrl("978-0-441-17271-9")).searchParams.get("isbn")).toBe("9780441172719");
    expect(new URL(querySearchUrl("dune herbert")).searchParams.get("q")).toBe("dune herbert");
  });

  it("lists every titled result in order, with its cover", () => {
    const response = {
      docs: [
        { title: "Dune", author_name: ["Frank Herbert"], first_publish_year: 1965, cover_i: 7 },
        { author_name: ["No Title"] },
        { title: "Dune Messiah" },
      ],
    };
    const results = resultsFromSearch(response);
    expect(results.map((result) => result.meta.title)).toEqual(["Dune", "Dune Messiah"]);
    expect(results[0]?.meta).toMatchObject({ authors: ["Frank Herbert"], published: "1965" });
    expect(results[0]?.coverUrl).toContain("/b/id/7-L.jpg");
    expect(results[1]?.meta.authors).toEqual([]);
  });
});
