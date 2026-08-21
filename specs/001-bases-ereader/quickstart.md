# Quickstart: Validating the Bases-Backed E-Reader

**Feature**: [spec.md](./spec.md) | **Date**: 2026-08-20

How to prove the feature works end to end. Each scenario maps to a user story and is independently
runnable, so a partially built plugin can still be validated up to the story it reaches.

## Prerequisites

- Obsidian desktop, version confirmed to expose `registerBasesView` (see research.md R1 — do not
  assume a number), with Bases enabled.
- Obsidian mobile on the same vault, for the parity scenarios.
- A scratch vault. Never validate against a vault with real notes — several scenarios delete things.
- One EPUB and one PDF. At least one containing a table of contents, and one with right-to-left text.

## Setup

```bash
npm install
npm run build            # produces main.js, manifest.json, styles.css
npm run dev              # rebuild on change
```

Link or copy the build output into `<scratch-vault>/.obsidian/plugins/obsidian-e-reader/`, then
enable the plugin in Community Plugins.

```bash
npm test                 # unit tests: anchoring, locators, frontmatter, settings migration
npm run test:watch
```

## S1 — Library view (US1, P1)

1. Create three notes with `type: book` frontmatter, each with `title`, `author`, `cover`, and one
   with `progress: 47`.
2. Create a `.base` file, add a view, choose **Library**.

**Expect**: three covers; the 47% book shows a bar filled to 47%, and a percentage when
`progressDisplay` is switched; the book with no `progress` reads as unread rather than 0%; a book
with a broken `cover` shows a title-and-author placeholder.

3. In the Bases toolbar, filter to one author, sort by title, add and remove a displayed property.

**Expect**: every change takes effect immediately and survives reopening the `.base` file — proving
Bases owns filtering and sorting, not the view (FR-002).

4. Add a fourth note *without* the marker property.

**Expect**: it never appears.

## S2 — Reading and position (US2, P2)

1. Attach an EPUB to a book note via `book-file`. Click its cover.

**Expect**: opens at the beginning, reports 0%.

2. Read to roughly the middle, close the tab, reopen from the library.

**Expect**: returns to the same place; the library tile's progress matches the reader within one
percentage point (SC-004).

3. Move the attachment to a different folder in the vault. Reopen.

**Expect**: still opens, position and metadata intact (FR-011).

4. Repeat 1–3 with the PDF.

5. **Sync rule**: with the vault synced to a second device, read further there, then return to the
   first and open the book.

**Expect**: opens where *this* device left off, and offers a jump to the further position. Declining
leaves both recorded positions unchanged, and progress never moves backwards (FR-015b, SC-003a).

## S3 — Highlights (US3, P3)

1. Select a passage in the EPUB and highlight it.

**Expect**: a `## Highlights` region appears at the end of the book note containing one blockquote
entry with a block reference; frontmatter is unchanged (FR-019); the highlight is painted in the book
and stays painted while scrolling (FR-016b).

2. Open the highlights sidebar tab and click the entry.

**Expect**: the book navigates to that passage.

3. Add commentary through the reader, then edit that commentary directly in the note.

**Expect**: each side reflects the other without a restart (FR-022).

4. Promote the highlight to its own note.

**Expect**: a note linking back to the book, transcluding the quote rather than copying it. Editing
the quote in the book note changes what the promoted note displays (FR-022b).

5. Type `![[Book#^id]]` in an unrelated note.

**Expect**: the quote renders there (FR-022c).

6. Delete the entry from the reader; then, separately, delete an entry directly from the note.

**Expect**: it disappears from both sides either way (FR-023). Deleting a promoted highlight warns
first.

7. Replace the EPUB with a different edition and reopen.

**Expect**: unresolvable highlights are listed as unanchored with their quoted text intact — never
silently dropped (FR-024).

8. Repeat 1, 2, and 6 with the PDF.

**Expect**: identical entry shape and identical sidebar behaviour (FR-016c).

## S4 — Outline (US4, P4)

Open a book with a table of contents, open the outline tab, select an entry, then scroll to another
chapter.

**Expect**: nested contents; navigation works; the current chapter is indicated. A book without
contents shows an explanatory empty state, not an error (FR-027).

## S5 — Catalog (US5, P5)

1. Configure a public OPDS 1.2 catalog. Search, then download a title.

**Expect**: a book note carrying the catalog's metadata with the file attached, appearing in the
library without a manual refresh (FR-032).

2. Download the same title again. **Expect**: a duplicate warning before anything is written.
3. Cancel a download midway. **Expect**: no partial file, no orphaned note (FR-033).
4. Point the plugin at an OPDS 2.0-only catalog. **Expect**: reported unsupported at configuration
   time (FR-030b).
5. Configure a credentialed catalog over plain HTTP. **Expect**: refused with an explanation
   (FR-031c).
6. On mobile, open a credentialed catalog. **Expect**: prompted for credentials, and told at entry
   that they will be needed again next session (FR-031d).

## S6 — Bookmarks (US6, P6)

Bookmark a location, reopen the book, check both sidebar tabs.

**Expect**: the bookmark persists, navigates, and appears **only** in the bookmarks tab while
highlights appear only in theirs (FR-028c).

## Cross-cutting checks

| Check | Expectation | Source |
|---|---|---|
| Startup cost | Enabling the plugin adds under 100 ms; no engine is parsed until a book opens | Principle V, FR-014d |
| Offline | Disable networking — everything except catalog search and download still works | FR-036, SC-011 |
| Idle writes | Leave a book open and idle; observe the vault | No writes occur (SC-009) |
| Clean unload | Disable the plugin | No leftover timers, listeners, or injected styles | Principle II |
| Mobile parity | Run S1–S6 on a phone | All complete with touch alone (SC-008, FR-038) |
| Large library | 500 book notes | First screen under 2 s, scrolling smooth (SC-001) |
| RTL | Open the right-to-left book | Renders correctly and is selectable | Edge Cases |
| Bundle | `ls -l main.js` and engine chunks | Authored code under 1 MB; engines under 5 MB; total under 6 MB | Constitution v1.1.0 |
