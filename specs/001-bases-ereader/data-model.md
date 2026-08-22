# Data Model: Bases-Backed E-Reader Library

**Feature**: [spec.md](./spec.md) | **Date**: 2026-08-20

All persistent state lives in vault content. The plugin holds no private database. Property names
below are defaults; FR-006 requires the marker to be reader-configurable, and the same setting
mechanism covers the rest.

## Book

A markdown note. Its frontmatter is the record; its body holds highlight entries (FR-009, FR-019).

| Property | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | Marker, value `book`. Name and value configurable (FR-006). |
| `title` | string | yes | Falls back to the note's basename. |
| `attachments` | list of links | no | A list — a book may carry both an EPUB and a PDF. Absent ⇒ entry shows but is not readable. |
| `cover` | url \| link | no | The card image property (FR-003a). May be a remote URL; FR-032a localises these on import. |
| `author` | list of links | no | Authors may be notes rather than plain strings. |
| `progress` | number | no | 0–100. Absent ⇒ no progress overlay, and no read-state badge (FR-004, FR-005). |
| `published` | date | no | |
| `source` | url | no | |
| `description` | string | no | |
| `tags` / `topics` | list | no | |
| `last-read` | Locator | no | Where the reader left off (FR-015a). |
| `furthest-read` | Locator | no | Advances only (FR-015a). Defined but not yet written. |

Names are configurable per FR-006. The properties the plugin only READS keep their conventional
names (`type`/`book`, `cover`, `attachments`); the ones it WRITES are namespaced in snake_case —
`reading_progress`, `reading_position`, `furthest_position` — because `progress` and `last-read` are
common enough that this plugin could overwrite another's values.

**Relationships**: owns 0..n Highlights (in its body) and 0..n Bookmarks (same storage). Referenced
by 0..n Promoted notes. References 0..1 Book file.

**Validation**
- `progress` outside 0–100 is clamped and reported, never written back silently.
- `progress` absent ⇒ neither overlay renders. The read-state badge IS derived from `progress`
  (FR-004, revised); there is no separate read-state property to protect from inference.
- Writing a highlight MUST NOT modify frontmatter (FR-019).
- Plugin-written keys MUST NOT overwrite pre-existing values of the same name (FR-006 edge case).

**Read-state badge** — derived, not stored:

```text
no progress ⇒ no badge      0 ⇒ unread      1–99 ⇒ reading      100 ⇒ finished
```

Automatic transitions only move forward. Any backward move is a deliberate reader action.

## Book file

An EPUB or PDF listed in the book note's `attachments`. **Read-only** — never rewritten (FR-010).
Located by vault link so it survives moves and renames (FR-011). May be referenced by more than
one Book.

Where `attachments` lists more than one readable file, the reader opens the most recently read of
them, and asks when there is no such record.

## Locator

A value object serialised to a string, resolved by format.

| Format | Shape | Example |
|---|---|---|
| EPUB | CFI from foliate-js | `epubcfi(/6/4!/4/2/2[ch01]/2/1:0)` |
| PDF | page and offset | `page=42&offset=118` |

A Locator is a **hint, not an authority** (R4). Reading position uses it directly; highlight
anchoring verifies it against quoted text and falls back to search on mismatch.

## Highlight

An entry in a Book's body. Not a note, not a frontmatter value — see
[contracts/highlight-entry.md](./contracts/highlight-entry.md) for the serialised form.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Block reference. Stable for the entry's lifetime (CHK016). |
| `exact` | string | yes | Authoritative anchor and displayed quote (FR-020). |
| `prefix` / `suffix` | string | no | Disambiguating context, 32 characters each side by default (configurable). |
| `hint` | Locator | no | Fast path only. |
| `type` | string | yes | From a configurable set. `bookmark` is reserved (FR-020a, FR-028a). |
| `note` | string | no | Inline commentary (FR-022a). |
| `created` | datetime | yes | Sort key when anchoring fails. |
| `anchored` | derived | — | Not stored. Computed at load; false ⇒ presented as unanchored (FR-024). |

**Ordering**: reading order by resolved position. Unanchored entries have no position; they sort by
`created` after anchored ones — a rule the spec does not state (CHK015, still open).

## Bookmark

Structurally identical to a Highlight, distinguished by `type: bookmark`, carrying no `note`
(FR-028a). `exact` is captured text serving as both anchor and label (FR-028b). Listed only in the
bookmarks tab (FR-028c).

## Promoted note

A note developed from one Highlight (FR-022b).

| Property | Type | Notes |
|---|---|---|
| `highlight-of` | link | The Book note. |
| `highlight-id` | string | The block reference. |

Its body **transcludes** `![[Book#^id]]` rather than copying the quote, so the quote has one source
of truth. Deleting the underlying Highlight leaves a dangling embed — behaviour unspecified in the
spec (CHK007); FR-023 requires a warning first.

## Catalog

Configured in plugin settings, **never** in vault content for credentials.

| Field | Type | Storage |
|---|---|---|
| `id` / `name` / `url` | string | Plugin data |
| `username` | string | Plugin data |
| `password` | string | `SecretStorage` keyed by catalog id, or session memory only (FR-031a) |

**Validation**: a catalog with credentials over a non-encrypted connection is refused (FR-031c).

## Library view configuration

Persisted by Bases in the `.base` file, read through `BasesViewConfig`.

| Key | Type | Purpose |
|---|---|---|
| `coverProperty` | property id | Which property supplies the cover (FR-003) |
| `progressProperty` | property id | Which property supplies progress (FR-005) |
| `progressDisplay` | `bar` \| `percent` | How progress renders (FR-005) |

Property visibility, order, filtering, sorting, and search are **owned by Bases** and are not
duplicated here (FR-002).
