// Minimal stand-in for the `obsidian` module so unit tests can run under
// vitest/node without the real Electron-hosted API. Fleshed out as tests
// need more surface area. Every exported shape here mirrors a real Obsidian
// API member; nothing is invented beyond what the real plugin API exposes,
// though the fake's *behaviour* (especially the frontmatter/section/block
// parsing in MetadataCache) is a small honest approximation, not the real
// markdown/YAML engine. Fields and getters prefixed with `_` are test-only
// introspection points that do not exist on the real classes.

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Opaque handle returned by `Events.on`, matching the real (empty) interface. */
export interface EventRef {}

class EventRefImpl implements EventRef {
  constructor(
    public events: Events,
    public name: string,
    public callback: (...args: unknown[]) => unknown,
  ) {}
}

export class Events {
  private listeners = new Map<string, Set<(...args: unknown[]) => unknown>>();

  on(name: string, callback: (...args: unknown[]) => unknown): EventRef {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(callback);
    return new EventRefImpl(this, name, callback);
  }

  off(name: string, callback: (...args: unknown[]) => unknown): void {
    this.listeners.get(name)?.delete(callback);
  }

  offref(ref: EventRef): void {
    const impl = ref as EventRefImpl;
    this.off(impl.name, impl.callback);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of this.listeners.get(name) ?? []) {
      callback(...args);
    }
  }
}

// ---------------------------------------------------------------------------
// Bases (type-only surface — pure modules under src/library only need the
// BasesPropertyId type at compile time, never any Bases runtime behaviour)
// ---------------------------------------------------------------------------

/** Mirrors obsidian.d.ts's `BasesPropertyId` exactly (verified against 1.13.1). */
export interface FrontmatterLinkCache { key: string; link: string; original: string }

export type BasesPropertyId = `${"note" | "formula" | "file"}.${string}`;

// ---------------------------------------------------------------------------
// TFile
// ---------------------------------------------------------------------------

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;

  constructor(path: string) {
    this.path = path;
    const slashIdx = path.lastIndexOf("/");
    this.name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
    const dotIdx = this.name.lastIndexOf(".");
    if (dotIdx > 0) {
      this.basename = this.name.slice(0, dotIdx);
      this.extension = this.name.slice(dotIdx + 1);
    } else {
      this.basename = this.name;
      this.extension = "";
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter / section / block parsing (small, honest approximation)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontmatter(content: string): { frontmatterText: string | null; body: string } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatterText: null, body: content };
  return { frontmatterText: match[1] ?? "", body: content.slice(match[0].length) };
}

function parseYamlScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseYamlScalar(item.trim()));
  }
  return s;
}

function parseFrontmatterYaml(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    if (line === undefined || !line.trim() || line.trim().startsWith("#")) continue;
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1] ?? "";
    const rest = keyMatch[2] ?? "";
    if (rest.trim() === "") {
      const items: unknown[] = [];
      while (i < lines.length) {
        const listLine = lines[i];
        if (listLine === undefined) break;
        const listMatch = listLine.match(/^\s*-\s*(.*)$/);
        if (!listMatch) break;
        items.push(parseYamlScalar(listMatch[1] ?? ""));
        i++;
      }
      result[key] = items.length > 0 ? items : null;
      continue;
    }
    result[key] = parseYamlScalar(rest);
  }
  return result;
}

function stringifyYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value === "" || /^[\s#[\]{}:,'"]/.test(value) || /:\s|#/.test(value) || value.trim() !== value) {
      return JSON.stringify(value);
    }
    return value;
  }
  return JSON.stringify(value);
}

function stringifyFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${stringifyYamlScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${stringifyYamlScalar(value)}`);
    }
  }
  return lines.join("\n");
}

export interface Position {
  start: { line: number; col: number; offset: number };
  end: { line: number; col: number; offset: number };
}

export interface SectionCache {
  type: string;
  position: Position;
}

export interface BlockCache {
  id: string;
  position: Position;
}

export interface CachedMetadata {
  frontmatterLinks?: FrontmatterLinkCache[];
  frontmatter?: Record<string, unknown>;
  sections?: SectionCache[];
  blocks?: Record<string, BlockCache>;
}

function classifyLine(line: string): string {
  if (/^#{1,6}\s/.test(line)) return "heading";
  if (/^>/.test(line)) return "blockquote";
  if (/^```/.test(line)) return "code";
  if (/^(\s*[-*+]\s|\s*\d+\.\s)/.test(line)) return "list";
  return "paragraph";
}

function buildSections(body: string): SectionCache[] {
  const lines = body.split("\n");
  const sections: SectionCache[] = [];
  let offset = 0;
  let groupLines: string[] = [];
  let groupStartLine = 0;
  let groupStartOffset = 0;

  const flush = (endLineIdx: number, endOffset: number) => {
    if (groupLines.length === 0) return;
    sections.push({
      type: classifyLine(groupLines[0] ?? ""),
      position: {
        start: { line: groupStartLine, col: 0, offset: groupStartOffset },
        end: { line: endLineIdx, col: (lines[endLineIdx] ?? "").length, offset: endOffset },
      },
    });
    groupLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineEndOffset = offset + line.length;
    if (line.trim() === "") {
      flush(i - 1, Math.max(offset - 1, 0));
    } else {
      if (groupLines.length === 0) {
        groupStartLine = i;
        groupStartOffset = offset;
      }
      groupLines.push(line);
    }
    offset = lineEndOffset + 1;
  }
  flush(lines.length - 1, Math.max(offset - 1, 0));
  return sections;
}

function buildBlocks(body: string): Record<string, BlockCache> {
  const lines = body.split("\n");
  const blocks: Record<string, BlockCache> = {};
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineEndOffset = offset + line.length;
    const match = line.match(/\^([A-Za-z0-9-]+)\s*$/);
    if (match) {
      const id = match[1] ?? "";
      blocks[id] = {
        id,
        position: {
          start: { line: i, col: 0, offset },
          end: { line: i, col: line.length, offset: lineEndOffset },
        },
      };
    }
    offset = lineEndOffset + 1;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export class Vault extends Events {
  getFiles(): TFile[] {
    return [...this._files.values()];
  }

  /** Raw filesystem view, which unlike the Vault is not filtered by extension. */
  adapter = {
    exists: async (path: string): Promise<boolean> =>
      this._files.has(path) || this._binaryContents.has(path),
    readBinary: async (path: string): Promise<ArrayBuffer> =>
      this._binaryContents.get(path) ?? new ArrayBuffer(0),
    list: async (dir: string): Promise<{ files: string[]; folders: string[] }> => {
      const prefix = dir === "" ? "" : `${dir}/`;
      const files = [...this._files.keys(), ...this._binaryContents.keys()].filter(
        (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
      );
      return { files, folders: [] };
    },
    getResourcePath: (path: string): string => `app://fake/${path}`,
  };

  /** Internal store, shared read/write with MetadataCache/FileManager in this file. */
  _files = new Map<string, TFile>();
  _contents = new Map<string, string>();
  _binaryContents = new Map<string, ArrayBuffer>();

  getAbstractFileByPath(path: string): TFile | null {
    return this._files.get(path) ?? null;
  }

  async read(file: TFile): Promise<string> {
    const content = this._contents.get(file.path);
    if (content === undefined) throw new Error(`File not found: ${file.path}`);
    return content;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const data = this._binaryContents.get(file.path);
    if (data === undefined) throw new Error(`File not found: ${file.path}`);
    return data;
  }

  async create(path: string, data: string): Promise<TFile> {
    if (this._files.has(path)) throw new Error(`File already exists: ${path}`);
    const file = new TFile(path);
    this._files.set(path, file);
    this._contents.set(path, data);
    this.trigger("create", file);
    return file;
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    if (this._files.has(path)) throw new Error(`File already exists: ${path}`);
    const file = new TFile(path);
    this._files.set(path, file);
    this._binaryContents.set(path, data);
    this.trigger("create", file);
    return file;
  }

  async modify(file: TFile, data: string): Promise<void> {
    if (!this._files.has(file.path)) throw new Error(`File not found: ${file.path}`);
    this._contents.set(file.path, data);
    this.trigger("modify", file);
  }
}

// ---------------------------------------------------------------------------
// MetadataCache
// ---------------------------------------------------------------------------

export class MetadataCache extends Events {
  constructor(private vault: Vault) {
    super();
  }

  /**
   * Unlike the real, incrementally-updated cache, this recomputes from the
   * vault's current content on every call — simpler, and never stale.
   */
  getFileCache(file: TFile): CachedMetadata | null {
    const content = this.vault._contents.get(file.path);
    if (content === undefined) return null;
    const { frontmatterText, body } = splitFrontmatter(content);
    return {
      frontmatter: frontmatterText !== null ? parseFrontmatterYaml(frontmatterText) : undefined,
      sections: buildSections(body),
      blocks: buildBlocks(body),
    };
  }

  /**
   * Approximates the real resolver closely enough for tests: an exact vault
   * path, then a path relative to `sourcePath`'s folder, then a vault-wide
   * search by filename (or basename, for a linkpath with no extension).
   * The real implementation additionally picks the *shortest* match when
   * several files share a name; this fake just returns the first (insertion
   * order), which is enough for tests that don't rely on that tie-break.
   */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const normalized = linkpath.trim();
    if (normalized === "") return null;

    const exact = this.vault._files.get(normalized);
    if (exact) return exact;

    const sourceSlash = sourcePath.lastIndexOf("/");
    const sourceFolder = sourceSlash >= 0 ? sourcePath.slice(0, sourceSlash) : "";
    const relative = sourceFolder ? `${sourceFolder}/${normalized}` : normalized;
    const relativeMatch = this.vault._files.get(relative);
    if (relativeMatch) return relativeMatch;

    for (const file of this.vault._files.values()) {
      if (file.name === normalized || file.basename === normalized) return file;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// FileManager
// ---------------------------------------------------------------------------

export class FileManager {
  constructor(private vault: Vault) {}

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const content = await this.vault.read(file);
    const { frontmatterText, body } = splitFrontmatter(content);
    const frontmatter = frontmatterText !== null ? parseFrontmatterYaml(frontmatterText) : {};
    fn(frontmatter);
    const newContent =
      Object.keys(frontmatter).length > 0 ? `---\n${stringifyFrontmatter(frontmatter)}\n---\n${body}` : body;
    await this.vault.modify(file, newContent);
  }

  /**
   * Does not model a configurable attachment folder (the real API does) —
   * this fake just avoids colliding with an existing vault path.
   */
  async getAvailablePathForAttachment(filename: string, _sourcePath?: string): Promise<string> {
    const dotIdx = filename.lastIndexOf(".");
    const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.slice(dotIdx) : "";
    let candidate = filename;
    let counter = 1;
    while (this.vault.getAbstractFileByPath(candidate)) {
      candidate = `${base} ${counter}${ext}`;
      counter++;
    }
    return candidate;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export class App {
  vault: Vault;
  metadataCache: MetadataCache;
  fileManager: FileManager;

  constructor() {
    this.vault = new Vault();
    this.metadataCache = new MetadataCache(this.vault);
    this.fileManager = new FileManager(this.vault);
  }
}

// ---------------------------------------------------------------------------
// Component / Plugin / ItemView
// ---------------------------------------------------------------------------

type Unregister = () => void;

export class Component {
  private _loaded = false;
  private _children: Component[] = [];
  private _unregisters: Unregister[] = [];

  load(): void {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
    for (const child of this._children) child.load();
  }

  unload(): void {
    if (!this._loaded) return;
    for (const child of this._children) child.unload();
    this._children = [];
    for (const unregister of this._unregisters.splice(0)) unregister();
    this.onunload();
    this._loaded = false;
  }

  onload(): void {}
  onunload(): void {}

  addChild<T extends Component>(child: T): T {
    this._children.push(child);
    if (this._loaded) child.load();
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    const idx = this._children.indexOf(child);
    if (idx >= 0) this._children.splice(idx, 1);
    child.unload();
    return child;
  }

  register(cb: Unregister): void {
    this._unregisters.push(cb);
  }

  registerEvent(eventRef: EventRef): void {
    this.register(() => {
      const impl = eventRef as EventRefImpl;
      impl.events.offref(eventRef);
    });
  }

  registerDomEvent(
    el: EventTarget,
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }

  registerInterval(id: number): number {
    this.register(() => clearInterval(id));
    return id;
  }

  /** Test-only: number of pending teardown actions, for asserting clean unload. */
  get _registrationCount(): number {
    return this._unregisters.length;
  }
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  [key: string]: unknown;
}

export class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  private _commands = new Map<string, unknown>();
  private _viewCreators = new Map<string, (leaf: unknown) => unknown>();
  private _data: unknown = null;

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: { id: string } & Record<string, unknown>): unknown {
    this._commands.set(command.id, command);
    this.register(() => this._commands.delete(command.id));
    return command;
  }

  registerView(type: string, viewCreator: (leaf: unknown) => unknown): void {
    this._viewCreators.set(type, viewCreator);
    this.register(() => this._viewCreators.delete(type));
  }

  registerExtensions(_extensions: string[], _viewType: string): void {
    // Recorded for parity; the fake does not drive real file-open behaviour.
  }

  async loadData(): Promise<unknown> {
    return this._data;
  }

  async saveData(data: unknown): Promise<void> {
    this._data = data;
  }

  /** Test-only introspection. */
  get _registeredCommandIds(): string[] {
    return [...this._commands.keys()];
  }

  /** Test-only introspection. */
  get _registeredViewTypes(): string[] {
    return [...this._viewCreators.keys()];
  }
}

export class WorkspaceLeaf {}

export class ItemView extends Component {
  leaf: WorkspaceLeaf;
  containerEl: EventTarget;
  contentEl: EventTarget;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.containerEl = new EventTarget();
    this.contentEl = new EventTarget();
  }

  getViewType(): string {
    throw new Error("getViewType must be implemented by subclass");
  }

  getDisplayText(): string {
    throw new Error("getDisplayText must be implemented by subclass");
  }

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

export class Notice {
  message: string;
  timeout?: number;

  constructor(message: string, timeout?: number) {
    this.message = message;
    this.timeout = timeout;
  }

  hide(): void {}
}

// ---------------------------------------------------------------------------
// requestUrl
// ---------------------------------------------------------------------------

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

export async function requestUrl(_request: RequestUrlParam | string): Promise<RequestUrlResponse> {
  throw new Error("requestUrl is not implemented in the obsidian test fake");
}

/** Structural stand-in for `BasesViewConfig`; tests supply their own object. */
export interface BasesViewConfig {
  get(key: string): unknown;
  getAsPropertyId(key: string): BasesPropertyId | null;
  getOrder(): BasesPropertyId[];
  getDisplayName(propertyId: BasesPropertyId): string;
  set(key: string, value: unknown): void;
}
