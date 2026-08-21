import { describe, it, expect, vi } from "vitest";
import {
  App,
  TFile,
  Vault,
  MetadataCache,
  FileManager,
  Component,
  Plugin,
  ItemView,
  Notice,
  requestUrl,
  WorkspaceLeaf,
} from "obsidian";

describe("TFile", () => {
  it("derives basename and extension from a nested path", () => {
    const file = new TFile("Books/Dune.epub");
    expect(file.path).toBe("Books/Dune.epub");
    expect(file.name).toBe("Dune.epub");
    expect(file.basename).toBe("Dune");
    expect(file.extension).toBe("epub");
  });

  it("handles a root file with no extension", () => {
    const file = new TFile("README");
    expect(file.basename).toBe("README");
    expect(file.extension).toBe("");
  });
});

describe("Vault", () => {
  it("creates, reads, and finds files by path", async () => {
    const vault = new Vault();
    const file = await vault.create("Books/Dune.md", "---\ntitle: Dune\n---\nBody");
    expect(vault.getAbstractFileByPath("Books/Dune.md")).toBe(file);
    await expect(vault.read(file)).resolves.toContain("Body");
  });

  it("returns null for a missing path", () => {
    const vault = new Vault();
    expect(vault.getAbstractFileByPath("nope.md")).toBeNull();
  });

  it("rejects creating a file that already exists", async () => {
    const vault = new Vault();
    await vault.create("a.md", "one");
    await expect(vault.create("a.md", "two")).rejects.toThrow();
  });

  it("modifies existing content", async () => {
    const vault = new Vault();
    const file = await vault.create("a.md", "one");
    await vault.modify(file, "two");
    await expect(vault.read(file)).resolves.toBe("two");
  });

  it("stores and reads binary content", async () => {
    const vault = new Vault();
    const data = new TextEncoder().encode("epub-bytes").buffer;
    const file = await vault.createBinary("Books/Dune.epub", data);
    const readBack = await vault.readBinary(file);
    expect(new Uint8Array(readBack)).toEqual(new Uint8Array(data));
  });
});

describe("MetadataCache", () => {
  it("parses frontmatter, sections, and blocks", async () => {
    const vault = new Vault();
    const metadataCache = new MetadataCache(vault);
    const file = await vault.create(
      "Books/Dune.md",
      ["---", "type: book", "title: Dune", "progress: 47", "---", "# Chapter 1", "", "He said hello. ^abc123"].join(
        "\n",
      ),
    );

    const cache = metadataCache.getFileCache(file);
    expect(cache?.frontmatter).toEqual({ type: "book", title: "Dune", progress: 47 });
    expect(cache?.sections?.some((s) => s.type === "heading")).toBe(true);
    expect(cache?.blocks?.["abc123"]).toBeDefined();
  });

  it("returns null for a file the vault does not know about", () => {
    const vault = new Vault();
    const metadataCache = new MetadataCache(vault);
    const ghost = new TFile("ghost.md");
    expect(metadataCache.getFileCache(ghost)).toBeNull();
  });
});

describe("FileManager", () => {
  it("mutates frontmatter in place via processFrontMatter", async () => {
    const vault = new Vault();
    const metadataCache = new MetadataCache(vault);
    const fileManager = new FileManager(vault);
    const file = await vault.create("Books/Dune.md", "---\ntitle: Dune\n---\nBody text");

    await fileManager.processFrontMatter(file, (fm) => {
      fm.progress = 50;
    });

    const content = await vault.read(file);
    expect(content).toContain("Body text");
    expect(metadataCache.getFileCache(file)?.frontmatter).toMatchObject({ title: "Dune", progress: 50 });
  });

  it("returns non-colliding attachment paths", async () => {
    const vault = new Vault();
    const fileManager = new FileManager(vault);
    const first = await fileManager.getAvailablePathForAttachment("cover.jpg");
    expect(first).toBe("cover.jpg");
    await vault.createBinary(first, new ArrayBuffer(0));
    const second = await fileManager.getAvailablePathForAttachment("cover.jpg");
    expect(second).not.toBe(first);
    expect(vault.getAbstractFileByPath(second)).toBeNull();
  });
});

describe("App", () => {
  it("wires vault, metadataCache, and fileManager together", async () => {
    const app = new App();
    expect(app.vault).toBeInstanceOf(Vault);
    expect(app.metadataCache).toBeInstanceOf(MetadataCache);
    expect(app.fileManager).toBeInstanceOf(FileManager);

    const file = await app.vault.create("a.md", "---\nfoo: bar\n---\n");
    expect(app.metadataCache.getFileCache(file)?.frontmatter).toEqual({ foo: "bar" });
  });
});

describe("Component clean unload", () => {
  it("tears down dom events, intervals, and event refs on unload", () => {
    const vault = new Vault();
    const target = new EventTarget();
    const handler = vi.fn();
    // Node's setInterval returns a Timeout handle rather than a number (as
    // it does in the browser/Electron runtime the real API targets); cast
    // to match registerInterval's browser-shaped signature.
    const intervalId = setInterval(() => {}, 1_000_000) as unknown as number;
    const clearSpy = vi.spyOn(global, "clearInterval");

    const component = new Component();
    component.registerDomEvent(target, "custom", handler);
    component.registerEvent(vault.on("create", handler));
    component.registerInterval(intervalId);

    component.load();
    target.dispatchEvent(new Event("custom"));
    vault.trigger("create", {});
    expect(handler).toHaveBeenCalledTimes(2);

    component.unload();
    target.dispatchEvent(new Event("custom"));
    vault.trigger("create", {});
    expect(handler).toHaveBeenCalledTimes(2); // no further calls after unload
    expect(clearSpy).toHaveBeenCalledWith(intervalId);

    clearSpy.mockRestore();
    clearInterval(intervalId);
  });

  it("unloads children when the parent unloads", () => {
    const parent = new Component();
    const child = new Component();
    const onunload = vi.fn();
    child.onunload = onunload;
    parent.addChild(child);
    parent.load();
    parent.unload();
    expect(onunload).toHaveBeenCalledTimes(1);
  });
});

describe("Plugin", () => {
  it("records and tears down commands and view registrations on unload", () => {
    const app = new App();
    const plugin = new Plugin(app, { id: "e-reader", name: "E-Reader", version: "0.1.0" });
    plugin.addCommand({ id: "open-library", name: "Open library" });
    plugin.registerView("e-reader-view", (leaf) => ({ leaf }));

    plugin.load();
    expect(plugin._registeredCommandIds).toContain("open-library");
    expect(plugin._registeredViewTypes).toContain("e-reader-view");

    plugin.unload();
    expect(plugin._registeredCommandIds).not.toContain("open-library");
    expect(plugin._registeredViewTypes).not.toContain("e-reader-view");
  });

  it("persists data through loadData/saveData", async () => {
    const app = new App();
    const plugin = new Plugin(app, { id: "e-reader", name: "E-Reader", version: "0.1.0" });
    await expect(plugin.loadData()).resolves.toBeNull();
    await plugin.saveData({ hello: "world" });
    await expect(plugin.loadData()).resolves.toEqual({ hello: "world" });
  });
});

describe("ItemView", () => {
  class TestView extends ItemView {
    override getViewType(): string {
      return "test-view";
    }
    override getDisplayText(): string {
      return "Test view";
    }
  }

  it("exposes a leaf and dom-event-capable container/content elements", () => {
    const leaf = new WorkspaceLeaf();
    const view = new TestView(leaf);
    expect(view.leaf).toBe(leaf);
    expect(view.containerEl).toBeInstanceOf(EventTarget);
    expect(view.contentEl).toBeInstanceOf(EventTarget);
    expect(view.getViewType()).toBe("test-view");
  });
});

describe("Notice", () => {
  it("records the message it was shown with", () => {
    const notice = new Notice("Import complete");
    expect(notice.message).toBe("Import complete");
  });
});

describe("requestUrl", () => {
  it("is unimplemented in the fake", async () => {
    await expect(requestUrl("https://example.com")).rejects.toThrow();
  });
});
