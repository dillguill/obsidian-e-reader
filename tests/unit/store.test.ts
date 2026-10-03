import { App, type TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { addEntry, listEntries, removeEntry, setEntryComment, setEntryType } from "../../src/annotations/store";
import { DEFAULT_SETTINGS, type HighlightSettings } from "../../src/settings/settings-model";

const NOW = new Date("2026-10-03T00:00:00.000Z");
let seed = 0;
const random = (): number => ((seed = (seed + 7) % 16) / 16);

function settings(format: HighlightSettings["format"]): HighlightSettings {
  return { ...DEFAULT_SETTINGS.highlights, format };
}

async function setup(): Promise<{ app: App; book: TFile }> {
  const app = new App();
  const book = await app.vault.create("Library/Dune.md", "---\ntype: book\n---\n\nMy notes.\n");
  return { app, book };
}

const draft = { type: "idea", exact: "the spice must flow", prefix: "He said", suffix: "and left", hint: { kind: "pdf" as const, page: 35 } };

describe("entry store", () => {
  it("writes a callout with a link back to the page", async () => {
    const { app, book } = await setup();
    await addEntry(app, book, draft, settings("callout"), NOW, random);
    const text = await app.vault.read(book);
    expect(text).toMatch(/> \[!idea\] Idea · \[p\. 35\]\(obsidian:\/\/e-reader\?vault=Test%20Vault&file=Library%2FDune\.md&id=h-[0-9a-f]{6}\)/);
    expect(text).toContain("> the spice must flow\n");
    const { entries } = await listEntries(app, book, settings("callout"));
    expect(entries.map((entry) => [entry.type, entry.exact])).toEqual([["idea", "the spice must flow"]]);
  });

  it("writes a plain quote, keeping the type in the anchor record", async () => {
    const { app, book } = await setup();
    await addEntry(app, book, draft, settings("quote"), NOW, random);
    const text = await app.vault.read(book);
    expect(text).not.toContain("[!");
    expect(text).toContain('"type":"idea"');
    const { entries } = await listEntries(app, book, settings("quote"));
    expect(entries[0]).toMatchObject({ type: "idea", exact: "the spice must flow", format: "quote" });
  });

  it("writes a note per highlight, with properties, and links it from the book note", async () => {
    const { app, book } = await setup();
    const entry = await addEntry(app, book, { ...draft, page: 35, section: "Book One" }, settings("note"), NOW, random);
    const note = app.vault.getAbstractFileByPath("Highlights/Dune/the spice must flow.md") as TFile;
    expect(note).not.toBeNull();
    expect(app.metadataCache.getFileCache(note)?.frontmatter).toMatchObject({
      book: "[[Dune]]",
      highlight: "idea",
      page: 35,
      section: "Book One",
      created: NOW.toISOString(),
    });
    expect(await app.vault.read(book)).toContain("- [[the spice must flow|“the spice must flow”]] · [p. 35]");

    const { entries } = await listEntries(app, book, settings("note"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: entry.id, type: "idea", exact: "the spice must flow", format: "note" });

    await setEntryComment(app, book, entry.id, "Worth comparing.", settings("note"));
    await setEntryType(app, book, entry.id, "question", settings("note"));
    const [updated] = (await listEntries(app, book, settings("note"))).entries;
    expect(updated).toMatchObject({ type: "question", comment: "Worth comparing." });

    await removeEntry(app, book, entry.id, settings("note"));
    expect(app.vault.getAbstractFileByPath(note.path)).toBeNull();
    expect((await listEntries(app, book, settings("note"))).entries).toHaveLength(0);
    expect(await app.vault.read(book)).not.toContain("the spice");
  });

  it("keeps each entry's own format when the setting changes", async () => {
    const { app, book } = await setup();
    const first = await addEntry(app, book, draft, settings("quote"), NOW, random);
    await addEntry(app, book, { ...draft, exact: "fear is the mind-killer" }, settings("callout"), NOW, random);
    await setEntryType(app, book, first.id, "question", settings("callout"));
    const { entries } = await listEntries(app, book, settings("callout"));
    expect(entries.find((entry) => entry.id === first.id)).toMatchObject({ type: "question", format: "quote" });
  });

  it("keeps bookmarks in the book note even in the note format", async () => {
    const { app, book } = await setup();
    await addEntry(app, book, { type: "bookmark", exact: "", hint: { kind: "pdf", page: 3 } }, settings("note"), NOW, random);
    expect(app.vault.getAbstractFileByPath("Highlights")).toBeNull();
    expect((await listEntries(app, book, settings("note"))).entries[0]?.type).toBe("bookmark");
  });
});
