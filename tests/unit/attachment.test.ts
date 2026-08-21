import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import { extractAttachmentLinkpaths, resolveBookAttachment } from "../../src/core/attachment";

describe("extractAttachmentLinkpaths", () => {
  it("returns an empty list when the property is absent", () => {
    expect(extractAttachmentLinkpaths(undefined)).toEqual([]);
    expect(extractAttachmentLinkpaths({})).toEqual([]);
  });

  it("unwraps a single wikilink string into one linkpath", () => {
    expect(extractAttachmentLinkpaths({ attachments: "[[Tao Te Ching.epub]]" })).toEqual(["Tao Te Ching.epub"]);
  });

  it("accepts a bare filename with no wikilink brackets", () => {
    expect(extractAttachmentLinkpaths({ attachments: "book.pdf" })).toEqual(["book.pdf"]);
  });

  it("reads a list of wikilinks in order", () => {
    expect(extractAttachmentLinkpaths({ attachments: ["[[a.epub]]", "[[b.pdf]]"] })).toEqual(["a.epub", "b.pdf"]);
  });

  it("strips a display-alias suffix (`[[file|alias]]`)", () => {
    expect(extractAttachmentLinkpaths({ attachments: "[[book.epub|My Book]]" })).toEqual(["book.epub"]);
  });

  it("ignores non-string entries in the list", () => {
    expect(extractAttachmentLinkpaths({ attachments: ["[[a.epub]]", 42, null] })).toEqual(["a.epub"]);
  });

  it("drops a blank linkpath", () => {
    expect(extractAttachmentLinkpaths({ attachments: "[[]]" })).toEqual([]);
  });

  it("reads a custom property name when given one", () => {
    expect(extractAttachmentLinkpaths({ files: "[[a.epub]]" }, "files")).toEqual(["a.epub"]);
  });
});

describe("resolveBookAttachment", () => {
  function setup() {
    const app = new App();
    return app;
  }

  // Obsidian's own frontmatter writer quotes wikilinks inside a YAML list
  // (`- "[[Book.epub]]"`) — unquoted `[[...]]` is itself valid (nested) YAML
  // flow-sequence syntax, so quoting is what keeps it a plain string. These
  // fixtures match that real serialised form.

  it("resolves the first readable (.epub/.pdf) attachment in list order", async () => {
    const app = setup();
    const note = await app.vault.create(
      "Tao Te Ching.md",
      ["---", "type: book", "attachments:", '  - "[[Tao Te Ching.epub]]"', "---", ""].join("\n"),
    );
    await app.vault.create("Tao Te Ching.epub", "");
    expect(resolveBookAttachment(app, note)?.path).toBe("Tao Te Ching.epub");
  });

  it("skips a non-readable attachment and resolves the next readable one", async () => {
    const app = setup();
    const note = await app.vault.create(
      "Book.md",
      ["---", "attachments:", '  - "[[cover-notes.md]]"', '  - "[[Book.pdf]]"', "---", ""].join("\n"),
    );
    await app.vault.create("cover-notes.md", "");
    await app.vault.create("Book.pdf", "");
    expect(resolveBookAttachment(app, note)?.path).toBe("Book.pdf");
  });

  it("returns null when there are no attachments", async () => {
    const app = setup();
    const note = await app.vault.create("Book.md", "---\ntype: book\n---\n");
    expect(resolveBookAttachment(app, note)).toBeNull();
  });

  it("returns null when the only attachment cannot be resolved to a vault file", async () => {
    const app = setup();
    const note = await app.vault.create("Book.md", '---\nattachments:\n  - "[[missing.epub]]"\n---\n');
    expect(resolveBookAttachment(app, note)).toBeNull();
  });
});

describe("extractAttachmentLinkpaths — real-world YAML shapes", () => {
  it("finds a link nested three deep, which is how `- [[Book.epub]]` parses", () => {
    // A YAML list item containing two flow sequences: [[["Book.epub"]]]
    expect(extractAttachmentLinkpaths({ attachments: [[["Tao Te Ching.epub"]]] })).toEqual([
      "Tao Te Ching.epub",
    ]);
  });

  it("still handles a quoted link, which parses as a plain string", () => {
    expect(extractAttachmentLinkpaths({ attachments: ["[[Book.pdf]]"] })).toEqual(["Book.pdf"]);
  });

  it("handles a bare filename", () => {
    expect(extractAttachmentLinkpaths({ attachments: ["Book.pdf"] })).toEqual(["Book.pdf"]);
  });

  it("handles several links at mixed depths", () => {
    expect(extractAttachmentLinkpaths({ attachments: [[["A.epub"]], "[[B.pdf]]"] })).toEqual([
      "A.epub",
      "B.pdf",
    ]);
  });
});
