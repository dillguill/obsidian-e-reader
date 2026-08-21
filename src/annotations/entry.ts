// Serialising and parsing one annotation entry, per
// specs/001-bases-ereader/contracts/highlight-entry.md.
//
// The visible `==quote==` is the single source of truth for the quoted text
// (contract rule 3): it is both what the reader sees and what re-anchoring
// matches against, so editing the quote by hand edits the anchor. The
// `%%…%%` comment carries only the surrounding metadata.
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
}

export interface MalformedEntry {
  id: string | null;
  reason: string;
  /** The entry's markdown exactly as found, so callers can leave it in place. */
  raw: string;
}

export type ParsedEntry = { ok: true; entry: Entry } | { ok: false; malformed: MalformedEntry };

const ID_RE = /^[a-z0-9-]+$/;
const CALLOUT_RE = /^\[!([a-zA-Z0-9_-]+)\]\s*(.*)$/;

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
  prefix?: string;
  suffix?: string;
  hint?: string;
  created: string;
}

/**
 * `%` is escaped as its % form so that a prefix or suffix captured from
 * the book — which can legitimately contain `%%` — cannot terminate the
 * Obsidian comment that wraps this JSON. The escape is plain JSON and parses
 * straight back to `%`.
 */
function encodeAnchorJson(anchor: AnchorRecord): string {
  const json: AnchorJson = { id: anchor.id, created: anchor.created };
  if (anchor.prefix !== undefined && anchor.prefix !== "") json.prefix = anchor.prefix;
  if (anchor.suffix !== undefined && anchor.suffix !== "") json.suffix = anchor.suffix;
  if (anchor.hint !== undefined) json.hint = serializeLocator(anchor.hint);
  return JSON.stringify(json).replace(/%/g, "\\u0025");
}

function quoteLines(text: string): string[] {
  return text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
}

/**
 * The entry's markdown, including the trailing block identifier. The `^id`
 * sits on its own line after a blank line: Obsidian's linking documentation
 * specifies that form for structured blocks (quotes, callouts, lists,
 * tables), unlike simple paragraphs where the identifier ends the line.
 */
export function serializeEntry(entry: Entry): string {
  const lines: string[] = [`> [!quote] ${entry.type}`];
  if (entry.exact !== "") lines.push(`> ==${entry.exact}==`);
  lines.push(`> %%${encodeAnchorJson(entry.anchor)}%%`);
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

function parseAnchor(json: string, fallbackId: string | null): AnchorRecord | string {
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
  return anchor;
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
  const calloutMatch = (inner[0] as string).trim().match(CALLOUT_RE);
  if (!calloutMatch) return malformed("first line is not a callout header");
  const type = (calloutMatch[2] ?? "").trim();
  if (type === "") return malformed("callout carries no entry type");

  let exact = "";
  let anchorJson: string | null = null;
  let commentStart = inner.length;

  for (let i = 1; i < inner.length; i++) {
    const line = (inner[i] as string).trim();
    if (line === "") continue;
    const commentMatch = line.match(/^%%(.*)%%$/);
    if (commentMatch) {
      anchorJson = (commentMatch[1] as string).replace(/\\u0025/g, "%");
      commentStart = i + 1;
      break;
    }
    if (exact === "" && line.startsWith("==") && line.endsWith("==") && line.length > 4) {
      // First `==` to last `==`, so a quote that itself contains `==`
      // round-trips exactly rather than being truncated at the inner marker.
      exact = line.slice(2, -2);
      continue;
    }
    return malformed("unexpected content before the anchor record");
  }

  if (anchorJson === null) return malformed("entry has no anchor record");
  const anchor = parseAnchor(anchorJson, blockId);
  if (typeof anchor === "string") return malformed(anchor);
  if (blockId !== null && blockId !== anchor.id) return malformed("block identifier does not match the anchor id");

  const comment = inner
    .slice(commentStart)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");

  return { ok: true, entry: { id: anchor.id, type, exact, comment, anchor } };
}
