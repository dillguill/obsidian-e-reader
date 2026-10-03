import { App, type TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { bookmarkId } from "../../src/annotations/bookmarks";
import { exportHighlightNote, renderTemplate } from "../../src/annotations/export-note";
import { parseNote } from "../../src/annotations/highlight-notes";
import { entryCopy, entryLink, findBookForEntry, highlightOfNote } from "../../src/annotations/links";
import {
  addEntry,
  fillSections,
  foldHighlightNotes,
  listEntries,
  migrateBookmarks,
  removeEntry,
  renameTypeInBook,
  setEntryComment,
  setEntryType,
} from "../../src/annotations/store";
import { DEFAULT_SETTINGS } from "../../src/settings/settings-model";

const NOW = new Date("2026-10-03T00:00:00.000Z");
let seed = 0;
const random = (): number => ((seed = (seed + 7) % 16) / 16);
const SETTINGS = DEFAULT_SETTINGS;

async function setup(): Promise<{ app: App; book: TFile }> {
  const app = new App();
  const book = await app.vault.create("Library/Dune.md", "---\ntype: book\n---\n\nMy notes.\n");
  return { app, book };
}

const draft = {
  type: "idea",
  exact: "the spice must flow",
  prefix: "He said",
  suffix: "and left",
  hint: { kind: "pdf" as const, page: 35 },
  section: "Book One",
};
const SOURCE = "– [Dune, Book One, p. 35](obsidian://e-reader?vault=Test%20Vault&id=";

describe("entry store", () => {
  it("writes a callout with a source line under the quote that opens the reader by entry id", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, draft, SETTINGS, NOW, random);
    const text = await app.vault.read(book);
    expect(text).toContain(`> [!idea]\n> the spice must flow\n> ${SOURCE}${entry.id})\n> %%`);
    expect(text).toContain('"section":"Book One"');
    const { entries } = await listEntries(app, book, SETTINGS);
    expect(entries.map((entry) => [entry.type, entry.exact])).toEqual([["idea", "the spice must flow"]]);
  });

  it("fills in the chapter of highlights saved without one, once", async () => {
    const { app, book } = await setup();
    const { section: _section, ...noSection } = draft;
    const entry = await addEntry(app, book, noSection, SETTINGS, NOW, random);
    const lookup = async (): Promise<string> => "Book One";
    expect(await fillSections(app, book, SETTINGS, lookup)).toBe(1);
    expect(await fillSections(app, book, SETTINGS, lookup)).toBe(0);
    expect(await app.vault.read(book)).toContain(`${SOURCE}${entry.id})`);
  });

  it("comments on, retypes and removes a highlight", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, draft, SETTINGS, NOW, random);
    await setEntryComment(app, book, entry.id, "Worth comparing.", SETTINGS);
    await setEntryType(app, book, entry.id, "question", SETTINGS);
    expect((await listEntries(app, book, SETTINGS)).entries[0]).toMatchObject({ type: "question", comment: "Worth comparing." });
    await removeEntry(app, book, entry.id, SETTINGS);
    expect((await listEntries(app, book, SETTINGS)).entries).toHaveLength(0);
  });

  it("still reads and edits a quote-style entry", async () => {
    const { app, book } = await setup();
    await app.vault.modify(
      book,
      (await app.vault.read(book)) +
        '\n## Highlights\n%%e-reader:begin%%\n\n> fear is the mind-killer\n> %%{"id":"h-000002","type":"idea","created":"2026-10-01T00:00:00.000Z"}%%\n\n^h-000002\n\n%%e-reader:end%%\n',
    );
    await setEntryType(app, book, "h-000002", "question", SETTINGS);
    expect((await listEntries(app, book, SETTINGS)).entries[0]).toMatchObject({ type: "question", format: "quote" });
  });
});

describe("copying and exporting a highlight", () => {
  it("copies it as a quote or a callout, with the note link beside the source and the comment after", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, { ...draft, comment: "Worth comparing." }, SETTINGS, NOW, random);
    const source = `> ${SOURCE}${entry.id}) · [[Dune#^${entry.id}|Link to note]]`;
    const tail = "Worth comparing.";
    expect(entryCopy(app, book, entry, false)).toBe(`> the spice must flow\n${source}\n\n${tail}`);
    expect(entryCopy(app, book, entry, true)).toBe(`> [!idea]\n> the spice must flow\n${source}\n\n${tail}`);
    expect(entryLink(app, book, entry)).toBe(`[[Dune#^${entry.id}]]`);
    expect(findBookForEntry(app, entry.id, SETTINGS.highlights)?.path).toBe(book.path);
  });

  it("leaves out a missing chapter rather than an empty slot", async () => {
    const { app, book } = await setup();
    const { section: _section, ...noSection } = draft;
    const entry = await addEntry(app, book, noSection, SETTINGS, NOW, random);
    expect(entryCopy(app, book, entry, false)).toContain("– [Dune, p. 35](");
  });

  it("exports it with the built-in layout: the quote copy, then properties", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, draft, SETTINGS, NOW, random);
    const note = await exportHighlightNote(app, book, entry, SETTINGS.highlights);
    expect(note.path).toBe("Highlights/Dune/the spice must flow.md");
    expect(app.metadataCache.getFileCache(note)?.frontmatter).toEqual({
      book: "[[Dune]]",
      highlight: "idea",
      chapter: "Book One",
      page: 35,
      created: NOW.toISOString(),
    });
    const text = await app.vault.read(note);
    expect(text.replace(/^---\n[\s\S]*?\n---\n/, "")).toBe(
      `> the spice must flow\n> ${SOURCE}${entry.id}) · [[Dune#^${entry.id}|Link to note]]\n`,
    );

    // The export is not a second copy: the book note still lists it once.
    expect((await listEntries(app, book, SETTINGS)).entries).toHaveLength(1);
    expect(highlightOfNote(app, note, SETTINGS.highlights)).toEqual({ id: entry.id, book });
    expect(highlightOfNote(app, book, SETTINGS.highlights)).toBeNull();
  });

  it("exports through a template, keeping the template's own properties", async () => {
    const { app, book } = await setup();
    await app.vault.create("Templates/Highlight.md", "---\ntags: reading\n---\n## {{book}} — {{chapter}}\n\n{{quote}}\n\n{{comment}}\n\n{{link}}\n");
    const entry = await addEntry(app, book, draft, SETTINGS, NOW, random);
    const note = await exportHighlightNote(app, book, entry, { ...SETTINGS.highlights, template: "Templates/Highlight" });
    expect(app.metadataCache.getFileCache(note)?.frontmatter).toMatchObject({ tags: "reading", book: "[[Dune]]" });
    expect(await app.vault.read(note)).toContain(`## Dune — Book One\n\nthe spice must flow\n\n[[Dune#^${entry.id}|Link to note]]\n`);
  });

  it("fills placeholders, keeps unknown ones and closes up blank lines", () => {
    expect(renderTemplate("{{a}}\n\n{{b}}\n\n{{c}}\n{{nope}}", { a: "A", b: "", c: "C" })).toBe("A\n\nC\n{{nope}}\n");
  });
});

describe("highlights from earlier betas", () => {
  const BETA14 =
    '---\nbook: "[[Dune]]"\nhighlight: question\n---\n' +
    '> the spice must flow\n> [p. 35](obsidian://e-reader?vault=V&file=Dune.md&id=h-abc123)\n> %%{"id":"h-abc123","type":"idea","created":"2026-10-01T00:00:00.000Z","hint":"page=35"}%%\n\nMine.\n';

  it("reads a 0.3.7-beta highlight note", () => {
    const entry = parseNote(BETA14, { book: "[[Dune]]", highlight: "question" }, SETTINGS.highlights);
    expect(entry).toMatchObject({ id: "h-abc123", type: "question", exact: "the spice must flow", comment: "Mine." });
  });

  it("folds beta highlight notes back into the book note and removes the 0.4.0-beta.1 embed", async () => {
    const { app, book } = await setup();
    await app.vault.modify(book, `${await app.vault.read(book)}\n## Highlights\n![[Highlights.base#This book]]\n`);
    await app.vault.create("Highlights/Dune/the spice must flow.md", BETA14);
    await app.vault.create(
      "Highlights/Dune/fear.md",
      '---\nbook: "[[Dune]]"\nhighlight: idea\ncreated: 2026-10-02T00:00:00.000Z\nanchor: "{\\"id\\":\\"h-def456\\",\\"hint\\":\\"page=40\\"}"\n---\n> fear is the mind-killer\n\n[p. 40](obsidian://e-reader?vault=V&id=h-def456)\n',
    );
    expect(await foldHighlightNotes(app, book, SETTINGS)).toBe(2);
    const text = await app.vault.read(book);
    expect(text).not.toContain("Highlights.base");
    expect(text).toContain("> [!question]");
    expect(text).toContain("^h-def456");
    expect(app.vault.getAbstractFileByPath("Highlights/Dune/fear.md")).toBeNull();
    const { entries } = await listEntries(app, book, SETTINGS);
    expect(entries.map((entry) => [entry.id, entry.comment])).toEqual([
      ["h-abc123", "Mine."],
      ["h-def456", ""],
    ]);
  });

  it("leaves exported notes alone when folding", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, draft, SETTINGS, NOW, random);
    const note = await exportHighlightNote(app, book, entry, SETTINGS.highlights);
    expect(await foldHighlightNotes(app, book, SETTINGS)).toBe(0);
    expect(app.vault.getAbstractFileByPath(note.path)).not.toBeNull();
  });
});

describe("bookmarks", () => {
  it("are a list property on the book note", async () => {
    const { app, book } = await setup();
    const mark = await addEntry(app, book, { type: "bookmark", exact: "", hint: { kind: "pdf", page: 3 } }, SETTINGS, NOW, random);
    expect(mark.id).toBe(bookmarkId("page=3"));
    expect(app.metadataCache.getFileCache(book)?.frontmatter?.["bookmarks"]).toEqual(["page=3"]);
    expect((await listEntries(app, book, SETTINGS)).entries).toMatchObject([{ id: mark.id, type: "bookmark", anchor: { hint: { kind: "pdf", page: 3 } } }]);
    await removeEntry(app, book, mark.id, SETTINGS);
    expect(app.metadataCache.getFileCache(book)?.frontmatter?.["bookmarks"]).toBeUndefined();
  });

  it("written into the note before 0.4.0 move to the property", async () => {
    const { app, book } = await setup();
    await app.vault.modify(
      book,
      (await app.vault.read(book)) +
        '\n## Highlights\n%%e-reader:begin%%\n\n> [!bookmark]\n> %%{"id":"h-000001","created":"2026-10-01T00:00:00.000Z","hint":"page=7"}%%\n\n^h-000001\n\n%%e-reader:end%%\n',
    );
    expect(await migrateBookmarks(app, book, SETTINGS)).toBe(1);
    const text = await app.vault.read(book);
    expect(text).not.toContain("e-reader:begin");
    expect(text).not.toContain("## Highlights");
    expect(app.metadataCache.getFileCache(book)?.frontmatter?.["bookmarks"]).toEqual(["page=7"]);
  });
});

describe("renaming a type", () => {
  it("renames it in the book note and on exported notes", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, draft, SETTINGS, NOW, random);
    await addEntry(app, book, { ...draft, exact: "a beginning", type: "question" }, SETTINGS, NOW, random);
    const note = await exportHighlightNote(app, book, entry, SETTINGS.highlights);
    expect(await renameTypeInBook(app, book, "idea", "insight", SETTINGS)).toBe(1);
    expect((await listEntries(app, book, SETTINGS)).entries.map((item) => item.type).sort()).toEqual(["insight", "question"]);
    expect(await app.vault.read(book)).toContain("[!insight]");
    expect(app.metadataCache.getFileCache(note)?.frontmatter?.["highlight"]).toBe("insight");
  });
});
