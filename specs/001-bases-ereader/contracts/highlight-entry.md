# Contract: Highlight Entry Format

**Status**: Resolved. Block-identifier placement is verified against Obsidian's official linking
documentation; entry lookup is verified against the `obsidian` 1.13.1 typings.
**Consumers**: reader surfaces, sidebar tabs, any human editing the note by hand.

## Placement

Entries live under a single designated heading at the end of the book note's body, delimited so the
plugin can find its own region without disturbing a reader's prose (CHK002).

```markdown
---
type: book
title: Dune
---

Whatever the reader has written about this book stays here, untouched.

## Highlights
%%e-reader:begin%%

> [!idea]
> the spice must flow
> – [Dune, Book One](obsidian://e-reader?vault=Vault&id=h-a1b2c3)
> %%{"id":"h-a1b2c3","created":"2026-08-20T10:04:00Z","prefix":"He said that ","suffix":" and then left.","hint":"epubcfi(/6/4!/4/2/2[ch01]/2/1:0)","section":"Book One"}%%
>
> Worth comparing to the guild's monopoly argument.

^h-a1b2c3

%%e-reader:end%%
```

## Rules

1. Everything outside the `begin`/`end` markers is the reader's and MUST NOT be modified.
2. One callout per entry. The callout's type carries the entry `type` (`> [!idea]`) and its title is left
   empty; `bookmark` is reserved. The pre-0.3.7 form, `> [!quote] <type>` with the quote in `==…==`,
   still parses. Entries are written as callouts. A plain-quote entry (from a 0.3.7 or 0.4.0 beta), which
   drops the callout header and carries `type` in the anchor JSON instead, still parses. Under the quote
   sits a source line, `– [Book, Chapter, p. 35](obsidian://e-reader?vault=…&id=<id>)` (parts left out
   when unknown). Betas put a bare reader link in the callout title or on its own quoted line instead; it is derived, ignored when parsing and rewritten when
   serialising. It names only the entry id; the handler finds the note holding that id. Links written by
   0.3.7 betas also carry `file=`, which is honoured while it resolves.
3. The quote line(s) before the comment are the authoritative anchor **and** the displayed quote. One copy only.
4. The `%%…%%` comment holds the anchor record as JSON. It is hidden in reading view.
5. The block reference `^id` sits on its **own line, separated from the blockquote by a blank line**.
   Obsidian's linking documentation specifies this form for structured blocks — quotations, callouts,
   lists, and tables — as distinct from simple paragraphs, where the identifier ends the line. The id
   MUST match the JSON and is stable for the entry's lifetime.
6. Text after the comment, inside the quote, is the reader's commentary.
7. A malformed or unparseable entry is left in place and reported, never rewritten or deleted.

## Anchor record schema

```json
{
  "id":      "string, required, matches ^[a-z0-9-]+$",
  "prefix":  "string, optional",
  "suffix":  "string, optional",
  "hint":    "string, optional — CFI for EPUB, page=N&offset=N for PDF",
  "section": "string, optional — chapter or section from the table of contents",
  "created": "string, required, ISO 8601"
}
```

`exact` is deliberately absent — it lives in the visible quote line so that editing the quote by hand
edits the anchor, keeping one source of truth.

## Resolution order

1. Apply `hint`; confirm the text there equals `exact`. Match ⇒ resolved.
2. Otherwise search the document for `exact`, disambiguated by `prefix`/`suffix`.
3. Exactly one match ⇒ resolved, and `hint` is refreshed.
4. Zero or many matches ⇒ **unanchored**. Preserve the entry, present it as unanchored (FR-024), and
   never discard it.

## Locating entries — use the metadata cache, not a parser

`CachedMetadata` exposes both structures needed, so entries are found through public API rather than
by scanning markdown:

- `blocks?: Record<string, BlockCache>` — maps each block id to its position. This is the authority
  on whether an `^id` actually attached; if an id is absent here, the entry did not register and must
  be reported rather than assumed.
- `sections?: SectionCache[]` — root-level blocks, each with `type` (including `'blockquote'` and
  `'callout'`) and an optional `id`.

Entry discovery is therefore: read `blocks` for ids beginning `h-`, confirm the corresponding section
is a callout or blockquote, and parse only that range. Hand-rolled block-id parsing is prohibited.

## Context window

`prefix` and `suffix` capture **32 characters** each, configurable. Long enough to disambiguate a
repeated phrase in ordinary prose, short enough that an edit near the quote does not invalidate the
anchor. Resolves CHK011.

## Still to verify during implementation

- Whether `%%…%%` inside a callout is hidden in both reading and live-preview modes. If it is visible
  in either, move the JSON to a fenced `%%`-wrapped block beneath the quote instead.
- Obsidian states it does not support links to specific *parts* of quotations and callouts. This
  contract only ever references a whole entry, so the limitation does not bite — but do not later
  introduce sub-entry references expecting them to resolve.

## Exported highlight notes (0.4.0)

The book note is the only store. "Export as note" writes a new note named `Book – p. 35 – opening words`.
Its body is a template (a note chosen in settings, or by default `{{highlight}}` then `{{comment}}`): the
quote whose last line is `– [Book, Chapter, p. 35](obsidian://…) · [[Book#^id|Link to note]]`, then the
comment. It gets `book`, `highlight`,
`chapter`, `page` and `created` properties (names configurable). The plugin never reads an exported note
back as an entry.

Betas briefly stored highlights only as notes of their own, with the anchor in a `%%…%%` line (0.3.7) or an
`anchor` JSON property (0.4.0-beta.1). Those are folded back into the book note's region as callouts when the
book is opened, and the `![[Highlights.base#This book]]` embed 0.4.0-beta.1 added is removed.

## Bookmarks (0.4.0)

Bookmarks are items of a list property on the book note (`bookmarks` by default), each a serialised locator.
Their entry id is `b-` plus a hash of the locator. Bookmark entries found in the region (pre-0.4.0) are moved
to the property when the book is opened.
