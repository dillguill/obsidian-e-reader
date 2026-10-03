import JSZip from "jszip";
import { App, type TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { BookImporter } from "../../src/import/importer";
import { DEFAULT_SETTINGS, type Settings } from "../../src/settings/settings-model";

const CONTAINER = `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`;

async function epub(title: string, author: string, withCover = true): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("META-INF/container.xml", CONTAINER);
  zip.file(
    "content.opf",
    `<package><metadata><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></metadata>` +
      `<manifest>${withCover ? `<item id="c" href="c.jpg" media-type="image/jpeg" properties="cover-image"/>` : ""}</manifest></package>`,
  );
  if (withCover) zip.file("c.jpg", new Uint8Array([9]));
  return zip.generateAsync({ type: "arraybuffer" });
}

function setup(overrides: Partial<Settings["import"]> = {}): { app: App; importer: BookImporter } {
  const app = new App();
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    import: { ...DEFAULT_SETTINGS.import, lookUpMetadata: false, filesFolder: "Library/files", ...overrides },
  };
  return { app, importer: new BookImporter(app as never, () => settings, async () => ({
      title: "A PDF",
      authors: ["Someone"],
      subject: null,
      pages: 12,
      cover: null,
    })) };
}

describe("BookImporter", () => {
  it("writes the file, the cover and a note linking both", async () => {
    const { app, importer } = setup();
    const result = await importer.import({ kind: "external", name: "dune.epub", data: await epub("Dune", "Frank Herbert") });
    expect(result.status).toBe("imported");
    expect(app.vault.getAbstractFileByPath("Library/files/Dune.epub")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath("Library/files/Dune cover.jpg")).not.toBeNull();
    const note = app.vault.getAbstractFileByPath("Library/Dune.md") as TFile;
    const fm = app.metadataCache.getFileCache(note)?.frontmatter;
    expect(fm).toMatchObject({
      type: "book",
      title: "Dune",
      author: ["Frank Herbert"],
      attachments: ["[[Dune.epub]]"],
      cover: "[[Dune cover.jpg]]",
    });
  });

  it("moves a file already in the vault rather than copying it", async () => {
    const { app, importer } = setup();
    const file = await app.vault.createBinary("Inbox/download (1).epub", await epub("Emma", "Jane Austen", false));
    const result = await importer.import({ kind: "vault", file });
    expect(result.status).toBe("imported");
    expect(file.path).toBe("Library/files/Emma.epub");
    expect(app.vault.getAbstractFileByPath("Inbox/download (1).epub")).toBeNull();
    expect(importer.wrote("Library/files/Emma.epub")).toBe(true);
  });

  it("refuses a duplicate before writing anything", async () => {
    const { app, importer } = setup();
    await importer.import({ kind: "external", name: "a.epub", data: await epub("Dune", "Frank Herbert") });
    const before = app.vault.getFiles().length;
    const again = await importer.import({ kind: "external", name: "b.epub", data: await epub("The Dune", "frank herbert") });
    expect(again.status).toBe("duplicate");
    expect(app.vault.getFiles().length).toBe(before);
  });

  it("does not overwrite a different book with the same title", async () => {
    const { app, importer } = setup();
    await importer.import({ kind: "external", name: "a.epub", data: await epub("Collected Poems", "Author One") });
    const second = await importer.import({ kind: "external", name: "b.epub", data: await epub("Collected Poems", "Author Two") });
    expect(second.status).toBe("imported");
    expect(app.vault.getAbstractFileByPath("Library/Collected Poems 1.md")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath("Library/files/Collected Poems 1.epub")).not.toBeNull();
  });

  it("undoes everything when writing the note fails", async () => {
    const { app, importer } = setup();
    const file = await app.vault.createBinary("Inbox/x.epub", await epub("Emma", "Jane Austen"));
    app.fileManager.processFrontMatter = async () => {
      throw new Error("disk full");
    };
    await expect(importer.import({ kind: "vault", file })).rejects.toThrow("disk full");
    expect(file.path).toBe("Inbox/x.epub");
    expect(app.vault.getFiles().map((f) => f.path)).toEqual(["Inbox/x.epub"]);
    expect(app.vault.getAbstractFileByPath("Library")).toBeNull();
  });

  it("reads a PDF through the reader it is given", async () => {
    const { app, importer } = setup();
    await importer.import({ kind: "external", name: "scan.pdf", data: new ArrayBuffer(4) });
    const note = app.vault.getAbstractFileByPath("Library/A PDF.md") as TFile;
    expect(app.metadataCache.getFileCache(note)?.frontmatter).toMatchObject({
      title: "A PDF",
      author: ["Someone"],
      pages: 12,
      attachments: ["[[A PDF.pdf]]"],
    });
  });

  it("ignores files that are not books", async () => {
    const { importer } = setup();
    expect(await importer.import({ kind: "external", name: "notes.txt", data: new ArrayBuffer(0) })).toEqual({
      status: "unsupported",
    });
  });

  it("puts files where Obsidian puts attachments when no folder is set", async () => {
    const { app, importer } = setup({ filesFolder: "" });
    await importer.import({ kind: "external", name: "a.epub", data: await epub("Dune", "Frank Herbert", false) });
    // The fake's attachment location is the vault root.
    expect(app.vault.getAbstractFileByPath("Dune.epub")).not.toBeNull();
  });

  describe("wishlist", () => {
    it("saves a book with no file, and refuses a second copy", async () => {
      const { app, importer } = setup();
      const added = await importer.addToWishlist({ title: "Piranesi", authors: ["Susanna Clarke"], subjects: [] });
      expect(added.status).toBe("imported");
      const note = app.vault.getAbstractFileByPath("Library/Piranesi.md") as TFile;
      const fm = app.metadataCache.getFileCache(note)?.frontmatter;
      expect(fm).toMatchObject({ type: "book", title: "Piranesi", author: ["Susanna Clarke"] });
      expect(fm?.["attachments"]).toBeUndefined();
      expect(fm?.["tags"]).toEqual(["wishlist"]);
      const again = await importer.addToWishlist({ title: "Piranesi", authors: ["Susanna Clarke"], subjects: [] });
      expect(again.status).toBe("duplicate");
    });

    it("attaches a file to a wishlist book, filling only what the note lacks", async () => {
      const { app, importer } = setup();
      await importer.addToWishlist({ title: "Emma", authors: ["J. Austen"], subjects: [] });
      const note = app.vault.getAbstractFileByPath("Library/Emma.md") as TFile;
      const result = await importer.attach(note, { kind: "external", name: "x.epub", data: await epub("Emma: A Novel", "Jane Austen") });
      expect(result.status).toBe("attached");
      const fm = app.metadataCache.getFileCache(note)?.frontmatter;
      expect(fm).toMatchObject({
        title: "Emma",
        author: ["J. Austen"],
        attachments: ["[[Emma.epub]]"],
        cover: "[[Emma cover.jpg]]",
      });
      // The book has arrived, so it is no longer on the wishlist.
      expect(fm?.["tags"]).toBeUndefined();
      expect(app.vault.getAbstractFileByPath("Library/files/Emma.epub")).not.toBeNull();
    });

    it("refuses a file that already belongs to another book", async () => {
      const { app, importer } = setup();
      await importer.import({ kind: "external", name: "dune.epub", data: await epub("Dune", "Frank Herbert") });
      await importer.addToWishlist({ title: "Emma", authors: [], subjects: [] });
      const dune = app.vault.getAbstractFileByPath("Library/files/Dune.epub") as TFile;
      const emma = app.vault.getAbstractFileByPath("Library/Emma.md") as TFile;
      const result = await importer.attach(emma, { kind: "vault", file: dune });
      expect(result.status).toBe("in-use");
    });

    it("imports a book that is on the wishlist into that note", async () => {
      const { app, importer } = setup();
      await importer.addToWishlist({ title: "Dune", authors: ["Frank Herbert"], subjects: [] });
      const result = await importer.import({ kind: "external", name: "dune.epub", data: await epub("Dune", "Frank Herbert") });
      expect(result.status).toBe("imported");
      if (result.status === "imported") expect(result.note.path).toBe("Library/Dune.md");
      expect(app.vault.getAbstractFileByPath("Library/Dune 1.md")).toBeNull();
      const fm = app.metadataCache.getFileCache(result.status === "imported" ? result.note : (null as never))?.frontmatter;
      expect(fm?.["attachments"]).toEqual(["[[Dune.epub]]"]);
    });
  });

  describe("changing a cover and details", () => {
    it("saves a new cover and trashes the old one when nothing else uses it", async () => {
      const { app, importer } = setup();
      await importer.import({ kind: "external", name: "dune.epub", data: await epub("Dune", "Frank Herbert") });
      const note = app.vault.getAbstractFileByPath("Library/Dune.md") as TFile;
      await importer.setCover(note, { data: new Uint8Array([1, 2]).buffer, extension: "png" }, true);
      expect(app.metadataCache.getFileCache(note)?.frontmatter?.["cover"]).toBe("[[Dune cover.png]]");
      expect(app.vault.getAbstractFileByPath("Library/files/Dune cover.png")).not.toBeNull();
      expect(app.vault.getAbstractFileByPath("Library/files/Dune cover.jpg")).toBeNull();
    });

    it("keeps the old cover when asked to, and can point at an image already in the vault", async () => {
      const { app, importer } = setup();
      await importer.import({ kind: "external", name: "dune.epub", data: await epub("Dune", "Frank Herbert") });
      const note = app.vault.getAbstractFileByPath("Library/Dune.md") as TFile;
      const image = await app.vault.createBinary("Art/dune.webp", new Uint8Array([3]).buffer);
      await importer.setCover(note, image, false);
      expect(app.metadataCache.getFileCache(note)?.frontmatter?.["cover"]).toBe("[[dune.webp]]");
      expect(app.vault.getAbstractFileByPath("Library/files/Dune cover.jpg")).not.toBeNull();
    });

    it("overwrites only the chosen details", async () => {
      const { app, importer } = setup();
      await importer.addToWishlist({ title: "Dune", authors: ["F. Herbert"], subjects: [], publisher: "Ace" });
      const note = app.vault.getAbstractFileByPath("Library/Dune.md") as TFile;
      await importer.setDetails(note, { title: "Dune (Deluxe)", authors: ["Frank Herbert"], subjects: [], pages: 412 });
      expect(app.metadataCache.getFileCache(note)?.frontmatter).toMatchObject({
        title: "Dune",
        author: ["Frank Herbert"],
        publisher: "Ace",
        pages: 412,
      });
    });
  });
});

