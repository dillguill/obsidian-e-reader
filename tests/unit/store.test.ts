import { App, type TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { bookmarkId } from "../../src/annotations/bookmarks";
import { highlightsBaseSource, parseNote } from "../../src/annotations/highlight-notes";
import { entryLink, findBookForEntry, highlightOfNote } from "../../src/annotations/links";
import {
  addEntry,
  listEntries,
  migrateBookmarks,
  moveToBookNote,
  moveToNotes,
  removeEntry,
  renameTypeInBook,
  setEntryComment,
  setEntryType,
} from "../../src/annotations/store";
import { DEFAULT_SETTINGS, type HighlightSettings, type Settings } from "../../src/settings/settings-model";

const NOW = new Date("2026-10-03T00:00:00.000Z");
let seed = 0;
const random = (): number => ((seed = (seed + 7) % 16) / 16);

function settings(highlights: Partial<HighlightSettings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, highlights: { ...DEFAULT_SETTINGS.highlights, ...highlights } };
}
const CALLOUT = settings();
const QUOTE = settings({ style: "quote" });
const NOTES = settings({ mode: "notes" });

async function setup(): Promise<{ app: App; book: TFile }> {
  const app = new App();
  const book = await app.vault.create("Library/Dune.md", "---\ntype: book\n---\n\nMy notes.\n");
  return { app, book };
}

const draft = { type: "idea", exact: "the spice must flow", prefix: "He said", suffix: "and left", hint: { kind: "pdf" as const, page: 35 } };
const LINK_RE = /\[p\. 35\]\(obsidian:\/\/e-reader\?vault=Test%20Vault&id=h-[0-9a-f]{6}\)/;

describe("entry store, book-note mode", () => {
  it("writes a callout whose title links back to the page by entry id alone", async () => {
    const { app, book } = await setup();
    await addEntry(app, book, draft, CALLOUT, NOW, random);
    const text = await app.vault.read(book);
    expect(text).toMatch(new RegExp(`> \\[!idea\\] Idea · ${LINK_RE.source}`));
    expect(text).toContain("> the spice must flow\n");
    const { entries } = await listEntries(app, book, CALLOUT);
    expect(entries.map((entry) => [entry.type, entry.exact])).toEqual([["idea", "the spice must flow"]]);
  });

  it("writes a plain quote, keeping the type in the anchor record", async () => {
    const { app, book } = await setup();
    await addEntry(app, book, draft, QUOTE, NOW, random);
    const text = await app.vault.read(book);
    expect(text).not.toContain("[!");
    expect(text).toContain('"type":"idea"');
    const { entries } = await listEntries(app, book, QUOTE);
    expect(entries[0]).toMatchObject({ type: "idea", exact: "the spice must flow", format: "quote" });
  });

  it("leaves the page link out when page links are off", async () => {
    const { app, book } = await setup();
    await addEntry(app, book, draft, settings({ pageLinks: false }), NOW, random);
    const text = await app.vault.read(book);
    expect(text).not.toContain("obsidian://");
    expect(text).toMatch(/> \[!idea\]\n> the spice must flow/);
  });

  it("keeps each entry's own style when the setting changes", async () => {
    const { app, book } = await setup();
    const first = await addEntry(app, book, draft, QUOTE, NOW, random);
    await addEntry(app, book, { ...draft, exact: "fear is the mind-killer" }, CALLOUT, NOW, random);
    await setEntryType(app, book, first.id, "question", CALLOUT);
    const { entries } = await listEntries(app, book, CALLOUT);
    expect(entries.find((entry) => entry.id === first.id)).toMatchObject({ type: "question", format: "quote" });
  });

  it("copies a block link and embed to the entry", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, draft, CALLOUT, NOW, random);
    expect(entryLink(app, book, entry, false)).toBe(`[[Dune#^${entry.id}]]`);
    expect(entryLink(app, book, entry, true)).toBe(`![[Dune#^${entry.id}]]`);
    expect(findBookForEntry(app, entry.id, CALLOUT.highlights)?.path).toBe(book.path);
  });
});

describe("entry store, notes mode", () => {
  it("writes a note with the anchor in its properties and only an embed in the book note", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, { ...draft, page: 35, section: "Book One" }, NOTES, NOW, random);
    const note = app.vault.getAbstractFileByPath("Highlights/Dune/the spice must flow.md") as TFile;
    expect(note).not.toBeNull();
    const frontmatter = app.metadataCache.getFileCache(note)?.frontmatter;
    expect(frontmatter).toMatchObject({ book: "[[Dune]]", highlight: "idea", page: 35, section: "Book One", created: NOW.toISOString() });
    expect(JSON.parse(frontmatter?.["anchor"] as string)).toEqual({ id: entry.id, prefix: "He said", suffix: "and left", hint: "page=35" });

    const body = await app.vault.read(note);
    expect(body).not.toContain("%%");
    expect(body).toMatch(new RegExp(`---\\n> the spice must flow\\n\\n${LINK_RE.source}\\n$`));

    const bookText = await app.vault.read(book);
    expect(bookText).toContain("## Highlights\n![[Highlights.base#This book]]\n");
    expect(bookText).not.toContain("the spice");
    expect(app.vault.getAbstractFileByPath("Highlights/Highlights.base")).not.toBeNull();

    // A second highlight does not embed the view twice.
    await addEntry(app, book, { ...draft, exact: "fear is the mind-killer" }, NOTES, NOW, random);
    expect((await app.vault.read(book)).match(/Highlights\.base/g)).toHaveLength(1);
  });

  it("reads, comments on, retypes and removes a highlight note", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, draft, NOTES, NOW, random);
    const { entries } = await listEntries(app, book, NOTES);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: entry.id, type: "idea", exact: "the spice must flow", format: "note" });

    await setEntryComment(app, book, entry.id, "Worth comparing.", NOTES);
    await setEntryType(app, book, entry.id, "question", NOTES);
    const [updated] = (await listEntries(app, book, NOTES)).entries;
    expect(updated).toMatchObject({ type: "question", comment: "Worth comparing.", anchor: { prefix: "He said" } });
    const path = updated?.source as string;
    expect(await app.vault.read(app.vault.getAbstractFileByPath(path) as TFile)).toMatch(/\)\n\nWorth comparing\.\n$/);

    await removeEntry(app, book, entry.id, NOTES);
    expect(app.vault.getAbstractFileByPath(path)).toBeNull();
    expect((await listEntries(app, book, NOTES)).entries).toHaveLength(0);
  });

  it("links to the note, and finds the book from the note or the id", async () => {
    const { app, book } = await setup();
    const created = await addEntry(app, book, draft, NOTES, NOW, random);
    const [entry] = (await listEntries(app, book, NOTES)).entries;
    expect(entryLink(app, book, entry!, true)).toBe("![[the spice must flow]]");
    expect(findBookForEntry(app, created.id, NOTES.highlights)?.path).toBe(book.path);
    const note = app.vault.getAbstractFileByPath(entry!.source as string) as TFile;
    expect(highlightOfNote(app, note, NOTES.highlights)).toEqual({ id: created.id, book });
    expect(highlightOfNote(app, book, NOTES.highlights)).toBeNull();
  });

  it("still reads a highlight note written by a 0.3.7 beta", async () => {
    const text =
      "---\nbook: \"[[Dune]]\"\nhighlight: question\n---\n" +
      '> the spice must flow\n> [p. 35](obsidian://e-reader?vault=V&file=Dune.md&id=h-abc123)\n> %%{"id":"h-abc123","type":"idea","created":"2026-10-01T00:00:00.000Z","hint":"page=35"}%%\n\nMine.\n';
    const entry = parseNote(text, { book: "[[Dune]]", highlight: "question" }, DEFAULT_SETTINGS.highlights);
    expect(entry).toMatchObject({ id: "h-abc123", type: "question", exact: "the spice must flow", comment: "Mine.", anchor: { hint: { kind: "pdf", page: 35 } } });
  });

  it("filters the embedded view to the embedding book", () => {
    const source = highlightsBaseSource(DEFAULT_SETTINGS.highlights);
    expect(source).toContain(`    - 'file.hasProperty("anchor")'`);
    expect(source).toContain(`        - 'note["book"] == this'`);
    expect(source).toContain("    name: This book");
    expect(source).toContain("      property: note.book");
  });
});

describe("bookmarks", () => {
  it("are a list property on the book note, whatever the mode", async () => {
    const { app, book } = await setup();
    const mark = await addEntry(app, book, { type: "bookmark", exact: "", hint: { kind: "pdf", page: 3 } }, NOTES, NOW, random);
    expect(mark.id).toBe(bookmarkId("page=3"));
    expect(app.metadataCache.getFileCache(book)?.frontmatter?.["bookmarks"]).toEqual(["page=3"]);
    expect(app.vault.getAbstractFileByPath("Highlights")).toBeNull();
    expect((await listEntries(app, book, NOTES)).entries).toMatchObject([{ id: mark.id, type: "bookmark", anchor: { hint: { kind: "pdf", page: 3 } } }]);

    await removeEntry(app, book, mark.id, NOTES);
    expect(app.metadataCache.getFileCache(book)?.frontmatter?.["bookmarks"]).toBeUndefined();
  });

  it("written into the note before 0.4.0 move to the property", async () => {
    const { app, book } = await setup();
    await app.vault.modify(
      book,
      (await app.vault.read(book)) +
        '\n## Highlights\n%%e-reader:begin%%\n\n> [!bookmark]\n> %%{"id":"h-000001","created":"2026-10-01T00:00:00.000Z","hint":"page=7"}%%\n\n^h-000001\n\n%%e-reader:end%%\n',
    );
    expect(await migrateBookmarks(app, book, CALLOUT)).toBe(1);
    const text = await app.vault.read(book);
    expect(text).not.toContain("e-reader:begin");
    expect(text).not.toContain("## Highlights");
    expect(app.metadataCache.getFileCache(book)?.frontmatter?.["bookmarks"]).toEqual(["page=7"]);
  });
});

describe("moving highlights", () => {
  it("moves book-note highlights into notes and back", async () => {
    const { app, book } = await setup();
    const first = await addEntry(app, book, draft, CALLOUT, NOW, random);
    await setEntryComment(app, book, first.id, "Mine.", CALLOUT);
    await addEntry(app, book, { ...draft, exact: "fear is the mind-killer", type: "question" }, CALLOUT, NOW, random);

    expect(await moveToNotes(app, book, NOTES)).toBe(2);
    let text = await app.vault.read(book);
    expect(text).not.toContain("e-reader:begin");
    expect(text).toContain("![[Highlights.base#This book]]");
    let { entries } = await listEntries(app, book, NOTES);
    expect(entries.map((entry) => [entry.id, entry.format])).toContainEqual([first.id, "note"]);
    expect(entries.find((entry) => entry.id === first.id)).toMatchObject({ comment: "Mine.", exact: "the spice must flow" });

    expect(await moveToBookNote(app, book, QUOTE)).toBe(2);
    text = await app.vault.read(book);
    expect(text).not.toContain("Highlights.base");
    expect(app.vault.getAbstractFileByPath("Highlights/Dune/the spice must flow.md")).toBeNull();
    ({ entries } = await listEntries(app, book, QUOTE));
    expect(entries.find((entry) => entry.id === first.id)).toMatchObject({ format: "quote", comment: "Mine.", type: "idea" });
    expect(entries).toHaveLength(2);
  });

  it("renames a type in the book note and in highlight notes", async () => {
    const { app, book } = await setup();
    await addEntry(app, book, draft, CALLOUT, NOW, random);
    await addEntry(app, book, { ...draft, exact: "fear is the mind-killer" }, NOTES, NOW, random);
    await addEntry(app, book, { ...draft, exact: "a beginning", type: "question" }, NOTES, NOW, random);
    expect(await renameTypeInBook(app, book, "idea", "insight", NOTES)).toBe(2);
    const types = (await listEntries(app, book, NOTES)).entries.map((entry) => entry.type).sort();
    expect(types).toEqual(["insight", "insight", "question"]);
    expect(await app.vault.read(book)).toContain("[!insight]");
  });
});
