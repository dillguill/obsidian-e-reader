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

> [!quote] idea
> ==the spice must flow==
> %%{"id":"h-a1b2c3","prefix":"He said that ","suffix":" and then left.","hint":"epubcfi(/6/4!/4/2/2[ch01]/2/1:0)","created":"2026-08-20T10:04:00Z"}%%
>
> Worth comparing to the guild's monopoly argument.

^h-a1b2c3

%%e-reader:end%%
```

## Rules

1. Everything outside the `begin`/`end` markers is the reader's and MUST NOT be modified.
2. One blockquote per entry. The callout's label carries the entry `type`; `bookmark` is reserved.
3. `==exact==` is the authoritative anchor **and** the displayed quote. One copy only.
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
  "created": "string, required, ISO 8601"
}
```

`exact` is deliberately absent — it lives in the visible `==…==` so that editing the quote by hand
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
