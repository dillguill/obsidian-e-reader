// Serialising and parsing one annotation entry, per
// specs/001-bases-ereader/contracts/highlight-entry.md.
//
// The entry is a callout whose type is the highlight's type (`> [!note]`), so
// a CSS snippet can style each type differently. The quote line under it is
// the single source of truth for the quoted text (contract rule 3): it is
// both what the reader sees and what re-anchoring matches against, so editing
// the quote by hand edits the anchor. The `%%…%%` comment carries only the
// surrounding metadata.
//
// The "quote" format is the same without the callout: a plain `> quote`, with
// the type carried in the anchor JSON instead. Under the quote, either form
// carries an attribution line that opens the reader at the highlight:
// `– [Dune, Book One, p. 35](obsidian://e-reader?…)`. It is derived, so it is
// skipped when parsing and rewritten when serialising. Betas put a bare link
// in the callout's title or on its own line instead; those parse too.
//
// Entries written before 0.3.7 used `> [!quote] <type>` with the quote
// wrapped in `==…==`. Those still parse, and the whole region is rewritten
// in the new form the next time any entry in that note changes.
//
// A malformed entry is never rewritten or discarded (contract rule 7) — the
// parser reports it and callers preserve the original text verbatim.

import { parseLocator, serializeLocator } from "../core/locator";
import type { AnchorRecord, EntryType, Locator } from "../core/types";

export interface Entry {
  id: string;
  /** The callout's label. `bookmark` is reserved (FR-020a, FR-028a). */
  type: EntryType;
  /** The quoted text. Empty for a bookmark, which marks a place rather than a passage. */
  exact: string;
  /** The reader's own commentary beneath the quote. Empty when there is none. */
  comment: string;
  anchor: AnchorRecord;
  /** How the entry is written. Absent means a callout. Kept per entry so changing the setting never rewrites old ones. */
  format?: EntryFormat;
  /** Path of the note the entry is written in, when that is not the book note: a highlight note's own path. */
  source?: string;
}

/**
 * Where an entry lives and in what shape. `callout` and `quote` are written
 * into the book note's region; `note` entries are notes of their own
 * (highlight-notes.ts).
 */
export type EntryFormat = "callout" | "quote" | "note";

/** A reader link (`[label](obsidian://e-reader?…)`), optionally after a dash, which is derived and never part of the quote. */
const JUMP_LINK_RE = /^(?:[–—-]\s*)?\[[^\]]*\]\(obsidian:\/\/e-reader\?[^)]*\)$/;

export function isJumpLink(text: string): boolean {
  return JUMP_LINK_RE.test(text.trim());
}

export interface MalformedEntry {
  id: string | null;
  reason: string;
  /** The entry's markdown exactly as found, so callers can leave it in place. */
  raw: string;
}

export type ParsedEntry = { ok: true; entry: Entry } | { ok: false; malformed: MalformedEntry };

const ID_RE = /^[a-z0-9-]+$/;
const CALLOUT_RE = /^\[!([^\]]+)\][+-]?\s*(.*)$/;
/** The callout type every entry used before types became callout types. */
const LEGACY_CALLOUT = "quote";

export function isValidEntryId(id: string): boolean {
  return ID_RE.test(id);
}

/** `h-` + 6 hex characters, matching the contract's example ids. */
export function newEntryId(random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += Math.floor(random() * 16).toString(16);
  }
  return `h-${suffix}`;
}

interface AnchorJson {
  id: string;
  /** Only in the quote form, which has no callout to carry it. */
  type?: string;
  prefix?: string;
  suffix?: string;
  hint?: string;
  section?: string;
  created?: string;
}

/**
 * `%` is escaped as its % form so that a prefix or suffix captured from
 * the book — which can legitimately contain `%%` — cannot terminate the
 * Obsidian comment that wraps this JSON. The escape is plain JSON and parses
 * straight back to `%`.
 */
function encodeAnchorJson(anchor: AnchorRecord, type?: string): string {
  const json: AnchorJson = { id: anchor.id };
  if (type !== undefined) json.type = type;
  json.created = anchor.created;
  if (anchor.prefix !== undefined && anchor.prefix !== "") json.prefix = anchor.prefix;
  if (anchor.suffix !== undefined && anchor.suffix !== "") json.suffix = anchor.suffix;
  if (anchor.hint !== undefined) json.hint = serializeLocator(anchor.hint);
  if (anchor.section !== undefined && anchor.section !== "") json.section = anchor.section;
  return JSON.stringify(json).replace(/%/g, "\\u0025");
}

export function quoteLines(text: string): string[] {
  return text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
}

/**
 * The entry's markdown, including the trailing block identifier. The `^id`
 * sits on its own line after a blank line: Obsidian's linking documentation
 * specifies that form for structured blocks (quotes, callouts, lists,
 * tables), unlike simple paragraphs where the identifier ends the line.
 */
export function serializeEntry(entry: Entry, attribution: string | null = null): string {
  const lines: string[] = [];
  if (entry.format !== "quote") lines.push(`> [!${entry.type}]`);
  if (entry.exact !== "") lines.push(...quoteLines(entry.exact));
  if (attribution !== null) lines.push(`> ${attribution}`);
  lines.push(`> %%${encodeAnchorJson(entry.anchor, entry.format === "quote" ? entry.type : undefined)}%%`);
  if (entry.comment !== "") {
    lines.push(">");
    lines.push(...quoteLines(entry.comment));
  }
  return `${lines.join("\n")}\n\n^${entry.id}\n`;
}

function stripQuoteMarker(line: string): string {
  const withoutMarker = line.replace(/^\s*>/, "");
  return withoutMarker.startsWith(" ") ? withoutMarker.slice(1) : withoutMarker;
}

function parseAnchor(json: string, fallbackId: string | null): { anchor: AnchorRecord; type?: string } | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return "anchor record is not valid JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "anchor record is not a JSON object";
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"] : fallbackId;
  if (id === null || !isValidEntryId(id)) return "anchor record has no valid id";
  const created = typeof record["created"] === "string" ? record["created"] : null;
  if (created === null) return "anchor record has no created timestamp";

  const anchor: AnchorRecord = { id, created };
  if (typeof record["prefix"] === "string") anchor.prefix = record["prefix"];
  if (typeof record["suffix"] === "string") anchor.suffix = record["suffix"];
  if (typeof record["hint"] === "string") {
    const hint: Locator | null = parseLocator(record["hint"]);
    // A hint that no longer parses is not fatal: the quote is the authority,
    // so the entry stays usable and simply re-anchors by search instead.
    if (hint !== null) anchor.hint = hint;
  }
  if (typeof record["section"] === "string" && record["section"].trim() !== "") anchor.section = record["section"].trim();
  return typeof record["type"] === "string" && record["type"].trim() !== "" ? { anchor, type: record["type"].trim() } : { anchor };
}

/**
 * Parses one entry's blockquote. `raw` is the blockquote text only — the
 * `^id` line is supplied separately by the caller, which reads it from
 * Obsidian's metadata cache rather than by scanning (see locate.ts).
 */
export function parseEntry(raw: string, blockId: string | null = null): ParsedEntry {
  const malformed = (reason: string): ParsedEntry => ({ ok: false, malformed: { id: blockId, reason, raw } });

  const lines = raw.split("\n").filter((line) => line.trim() !== "" || true);
  if (lines.length === 0 || !/^\s*>/.test(lines[0] as string)) return malformed("not a blockquote");

  const inner = lines.map(stripQuoteMarker);
  // A callout header makes it the callout form; anything else is the quote
  // form, whose first line is already part of the quote.
  const calloutMatch = (inner[0] as string).trim().match(CALLOUT_RE);
  let calloutTypeName: string | null = null;
  if (calloutMatch) {
    const calloutType = (calloutMatch[1] ?? "").trim();
    const title = (calloutMatch[2] ?? "").trim();
    // The old form put the type in the title of a `quote` callout. A `quote`
    // callout with no title, or only a reader link there, is the new form
    // for a type named "quote".
    const legacy = calloutType.toLowerCase() === LEGACY_CALLOUT && title !== "" && !title.includes("](obsidian://e-reader?");
    calloutTypeName = legacy ? title : calloutType;
    if (calloutTypeName === "") return malformed("callout carries no entry type");
  }

  const quote: string[] = [];
  let anchorJson: string | null = null;
  let commentStart = inner.length;

  for (let i = calloutMatch ? 1 : 0; i < inner.length; i++) {
    const line = (inner[i] as string).trim();
    if (line === "") continue;
    const commentMatch = line.match(/^%%(.*)%%$/);
    if (commentMatch) {
      anchorJson = (commentMatch[1] as string).replace(/\\u0025/g, "%");
      commentStart = i + 1;
      break;
    }
    if (isJumpLink(line)) continue;
    quote.push(line);
  }

  let exact = quote.join(" ");
  if (exact.startsWith("==") && exact.endsWith("==") && exact.length > 4) {
    // The old form's highlight marks. First `==` to last `==`, so a quote
    // that itself contains `==` round-trips rather than being truncated.
    exact = exact.slice(2, -2);
  }

  if (anchorJson === null) return malformed("entry has no anchor record");
  const parsedAnchor = parseAnchor(anchorJson, blockId);
  if (typeof parsedAnchor === "string") return malformed(parsedAnchor);
  const { anchor } = parsedAnchor;
  if (blockId !== null && blockId !== anchor.id) return malformed("block identifier does not match the anchor id");
  const type = calloutTypeName ?? parsedAnchor.type;
  if (type === undefined) return malformed("quote carries no entry type");

  const comment = inner
    .slice(commentStart)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

  const entry: Entry = { id: anchor.id, type, exact, comment, anchor };
  if (calloutMatch === null) entry.format = "quote";
  return { ok: true, entry };
}
