---
description: "Task list for the Bases-backed e-reader library"
---

# Tasks: Bases-Backed E-Reader Library

**Input**: Design documents from `/specs/001-bases-ereader/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included and **not optional**. Constitution v1.1.0 Principle III makes TDD non-negotiable:
write the test, watch it fail for the intended reason, then implement. Every bugfix carries a
regression test reproducing the reported symptom.

**Organization**: Grouped by user story so each can be implemented, tested, and shipped independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story the task belongs to
- Exact file paths are given in each description

## Path Conventions

Single project, Obsidian plugin. `src/` and `tests/` at repository root; `vendor/` holds pinned
rendering engines. Paths follow the structure in [plan.md](./plan.md).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: A plugin that loads, does nothing, and unloads cleanly.

- [X] T001 Initialize the npm project with `package.json`, TypeScript 5.x, and `obsidian` as a dev dependency at the version matching `minAppVersion` 1.10.0
- [X] T002 Create `tsconfig.json` with `strict: true`, ES2022 modules, and `noUncheckedIndexedAccess`
- [X] T003 [P] Create `esbuild.config.mjs` bundling `src/main.ts` to `main.js`, with `obsidian` external and dynamic imports emitted as separate chunks
- [X] T004 [P] Create `manifest.json` with `id`, `name`, `version`, `minAppVersion: "1.10.0"`, and `isDesktopOnly: false`
- [X] T005 [P] Configure Vitest in `vitest.config.ts` with an alias mapping `obsidian` to the test fake
- [X] T006 [P] Configure linting and formatting, failing the build on any error per the constitution's merge gates
- [X] T007 Create the directory skeleton `src/{core,library,reader,annotations,sidebar,catalog,settings}` and `tests/{unit,fakes}`
- [X] T008 Implement a minimal `src/main.ts` that loads and unloads leaving zero timers, listeners, or injected styles
- [X] T009 Add an `npm run build` bundle-size check asserting authored code under 1 MB and total under 6 MB, per constitution v1.1.0

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The minimum shared by two or more stories. Deliberately small — anything used by exactly one story belongs to that story.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T010 [P] Create the Obsidian test fake in `tests/fakes/obsidian.ts` covering `TFile`, `Vault`, `MetadataCache`, `requestUrl`, and `Component`
- [X] T011 [P] Define shared types in `src/core/types.ts` — `Book`, `Locator`, `AnchorRecord`, `EntryType`, `ReadState`
- [X] T012 Write failing tests in `tests/unit/locator.test.ts` for serialising and parsing EPUB CFI and PDF `page=N&offset=N` locators, including malformed input
- [X] T013 Implement `src/core/locator.ts` to satisfy T012
- [X] T014 Write failing tests in `tests/unit/settings.test.ts` for the property-name settings model, covering configurable names and defaults per FR-006
- [X] T015 Implement `src/settings/settings-model.ts` with kebab-case defaults `type`/`book`, `cover`, `attachments`, `read-state`, `progress`, `last-read`, `furthest-read`
- [X] T016 Implement `src/settings/settings-tab.ts` exposing property-name overrides and the annotation type vocabulary

**Checkpoint**: Foundation ready — user stories can now proceed in parallel.

---

## Phase 3: User Story 1 — See the whole library at a glance (Priority: P1) 🎯 MVP

**Goal**: A Bases view rendering books as cards with overlays for the properties it scopes.

**Independent Test**: Create book notes, point a `.base` at them, select the Library view. Covers render; read state and progress overlay when bound; filtering, sorting, grouping, and property selection all behave as in any Bases view. No reader, no import, no annotations.

### Tests for User Story 1

- [X] T017 [P] [US1] Write failing tests in `tests/unit/overlay.test.ts` for overlay resolution — bound property with a value renders, unbound renders nothing, empty value renders nothing, and read state is never inferred from progress (FR-004, FR-005)
- [X] T018 [P] [US1] Write failing tests in `tests/unit/view-config.test.ts` for reading `coverProperty`, `progressProperty`, `readStateProperty`, and `progressDisplay` from a `BasesViewConfig` fake

### Implementation for User Story 1

- [X] T019 [US1] Implement overlay resolution in `src/library/overlay.ts` to satisfy T017
- [X] T020 [US1] Implement view-config reads in `src/library/view-config.ts` to satisfy T018
- [X] T021 [US1] Implement `src/library/library-view.ts` as a `BasesView` subclass with `type` and `onDataUpdated()`, reading `this.data` — no argument, per [contracts/bases-view.md](./contracts/bases-view.md)
- [X] T022 [US1] Render from `this.data.groupedData` so the reader's grouping is honoured, falling back to the single empty-keyed group when none is set (FR-007a)
- [X] T023 [US1] Implement card rendering in `src/library/card.ts` matching the built-in Cards view using Obsidian's CSS variables and class conventions — no bespoke design (FR-003, FR-008a)
- [X] T024 [US1] Apply the read-state and progress overlays to the card image, defaulting to a rendering distinguishable by more than colour (FR-008d)
- [X] T025 [US1] Register the view in `src/main.ts` via `registerBasesView('ereader-library', {...})`, checking its boolean return and reporting failure
- [X] T026 [US1] Declare view options through Bases primitives — `BasesPropertyOption` for the three property bindings with `default: 'note.cover'` for the image, `BasesDropdownOption` for `progressDisplay`, `BasesSliderOption` for card sizing (FR-008b, FR-008c)
- [X] T027 [US1] Add `styles.css` scoped to the view, using theme variables only
- [X] T028 [US1] Implement open-on-selection in `src/library/open-book.ts`, honouring Obsidian's modifier conventions for new tab and split (FR-007)
- [X] T029 [US1] Verify quickstart scenario S1 end to end on desktop and mobile

**Checkpoint**: US1 is independently functional — a working library browser.

---

## Phase 4: User Story 2 — Open a book and pick up where you left off (Priority: P2)

**Goal**: Both formats render in plugin-owned surfaces, with position restored and progress written back.

**Independent Test**: Open an EPUB and a PDF from the library, read partway, close, reopen. Position and progress restore, including after the file is moved. Sync offers a jump to a further position without ever rewinding.

### Tests for User Story 2

- [ ] T030 [P] [US2] Write failing tests in `tests/unit/position.test.ts` for the furthest-position rule — furthest only advances, opening restores last-read, declining a jump changes neither value (FR-015a, FR-015b, FR-015c)
- [ ] T031 [P] [US2] Write failing tests in `tests/unit/frontmatter.test.ts` for reading and writing book properties without disturbing unrelated frontmatter keys or the note body (FR-019, FR-037)
- [ ] T032 [P] [US2] Write failing tests in `tests/unit/debounce.test.ts` asserting that an unchanged position produces no write (FR-037a, SC-009)

### Implementation for User Story 2

- [ ] T033 [US2] Implement `src/core/frontmatter.ts` on `FileManager.processFrontMatter` to satisfy T031
- [ ] T034 [US2] Implement position tracking in `src/reader/position.ts` to satisfy T030 and T032
- [ ] T035 [US2] Define the engine interface in `src/reader/engine.ts` per [contracts/reader-engine.md](./contracts/reader-engine.md)
- [ ] T036 [US2] Vendor foliate-js into `vendor/foliate-js/` pinned to a specific commit, recording the commit and its MIT licence
- [ ] T037 [US2] Vendor the pdfjs-dist runtime into `vendor/pdfjs/` — `pdf.min.mjs` and `pdf.worker.min.mjs` only, no source maps, no cmaps or standard fonts in this release (research.md R3)
- [ ] T038 [P] [US2] Implement `src/reader/epub/adapter.ts` as the sole importer of foliate-js, behind a dynamic `import()`
- [ ] T039 [P] [US2] Implement `src/reader/pdf/adapter.ts` as the sole importer of pdfjs-dist, behind a dynamic `import()`, with the worker resolved from the vendored chunk
- [ ] T040 [US2] Implement `src/reader/reader-view.ts` as an `ItemView` that hosts an engine and reports the **book note** as its active file, so Obsidian's own properties, backlinks, and search panes operate on it (FR-014e)
- [ ] T041 [US2] Resolve which attachment to open when `attachments` lists several, opening the most recently read and asking otherwise (FR-013a)
- [ ] T042 [US2] Implement text-size and zoom controls per format (FR-017)
- [ ] T043 [US2] Implement in-book search with streamed results for both engines (FR-016)
- [ ] T044 [US2] Implement the further-position prompt, applied only on acceptance (FR-015b)
- [ ] T045 [US2] Assert engine chunks are absent from startup and load only on first open, with a test guarding the 100 ms budget (FR-014d)
- [ ] T046 [US2] Verify quickstart scenario S2 on desktop and mobile, including the moved-file and two-device cases

**Checkpoint**: US1 + US2 together are the true MVP — see your books, open one, come back later.

---

## Phase 5: User Story 3 — Highlight and annotate as durable notes (Priority: P3)

**Goal**: Highlights as anchored blockquote entries in the book note, two-way synced.

**Independent Test**: Highlight in both formats, confirm entries appear in the book note with block references, edit from either side, promote one, cite it elsewhere, delete from each side, and replace the file to confirm unanchored preservation.

### Tests for User Story 3

- [X] T047 [P] [US3] Write failing tests in `tests/unit/annotations.test.ts` for serialising and parsing the entry format in [contracts/highlight-entry.md](./contracts/highlight-entry.md), including malformed entries that must be preserved and reported
- [X] T048 [P] [US3] Write failing tests in `tests/unit/annotations.test.ts` for text-quote resolution — hint hit, hint miss then search, ambiguous match, and no match yielding unanchored (FR-024)
- [X] T049 [P] [US3] Write failing tests in `tests/unit/annotations.test.ts` asserting that content outside the `%%e-reader:begin/end%%` markers is never modified (FR-037b)

### Implementation for User Story 3

- [X] T050 [US3] Implement `src/annotations/anchor.ts` with a 32-character prefix/suffix window to satisfy T048
- [X] T051 [US3] Implement `src/annotations/entry.ts` to satisfy T047 and T049
- [X] T052 [US3] Implement entry discovery in `src/annotations/locate.ts` using `CachedMetadata.blocks` and `sections` — hand-rolled block-id parsing is prohibited
- [ ] T053 [US3] Verify in a real vault that `^id` after a blank line attaches to the blockquote and that `%%…%%` is hidden in reading and live-preview; apply the documented fallback if not
- [X] T054 [US3] Implement `src/annotations/store.ts` for two-way sync, reacting to metadata-cache changes (FR-022)
- [X] T055 [US3] Implement highlight creation from a selection in both adapters, writing the entry and painting it (FR-016b)
- [ ] T056 [US3] Implement persistent highlight painting via foliate-js `overlayer.js` for EPUB and a text-layer overlay for PDF
- [X] T057 [US3] Implement `src/sidebar/highlights-view.ts` listing entries in reading order with unanchored ones grouped after, separated and sorted by creation time
- [X] T058 [US3] Implement type filtering in the highlights sidebar (FR-020a)
- [X] T059 [US3] Implement in-place commentary editing (FR-022a)
- [ ] T060 [US3] Implement `src/annotations/promote.ts` creating a note that transcludes the entry rather than copying its quote (FR-022b)
- [ ] T061 [US3] Implement deletion from both sides, routed through the vault trash, warning when a promoted note depends on the entry (FR-023)
- [ ] T062 [US3] Verify quickstart scenario S3 for both formats

**Checkpoint**: Annotation works end to end and survives an edition change.

---

## Phase 6: User Story 4 — Navigate by the book's own structure (Priority: P4)

**Goal**: An outline from the book file's table of contents, falling back to the note.

**Independent Test**: Open books with and without a table of contents; confirm nesting, navigation, current-position indication, and the empty state.

- [ ] T063 [P] [US4] Write failing tests in `tests/unit/outline.test.ts` for nesting, the note fallback, and the empty case (FR-025, FR-025a, FR-027)
- [ ] T064 [US4] Implement table-of-contents extraction in both adapters
- [X] T065 [US4] ~~Implement `src/sidebar/outline-view.ts`~~ — **superseded**: Obsidian's own Outline pane already follows the reader. Its base class tracks the workspace `file-open` event, which `FileView.loadFile()` fires; the reader now loads through `loadFile` so the native pane (and the native Properties pane) resolve against the book note with no view of our own. A book-file table of contents remains available from each engine's `outline()` for in-reader navigation.
- [ ] T066 [US4] Implement current-position indication as the reader scrolls (FR-026)
- [ ] T067 [US4] Verify quickstart scenario S4

**Checkpoint**: Long-form navigation is usable.

---

## Phase 7: User Story 5 — Find and add books without leaving Obsidian (Priority: P5)

**Goal**: OPDS 1.2 search, browse, and atomic download into a book note.

**Independent Test**: Configure a catalog, search, download, and confirm a complete book note appears in the library. Confirm duplicates warn, failures leave nothing behind, and 2.0-only catalogs are refused at configuration time.

### Tests for User Story 5

- [ ] T068 [P] [US5] Write failing tests in `tests/unit/opds.test.ts` parsing OPDS 1.2 Atom fixtures — acquisition links, images, subsections, paging, search — plus an OPDS 2.0 payload that must be rejected (FR-030a, FR-030b)
- [ ] T069 [P] [US5] Write failing tests in `tests/unit/download.test.ts` asserting that a failed or cancelled download leaves no partial file and no orphaned note (FR-033)

### Implementation for User Story 5

- [ ] T070 [US5] Assess foliate-js's bundled OPDS client against [contracts/opds-client.md](./contracts/opds-client.md); adopt it wholly or write the parser, never half-adopt (research.md R5)
- [ ] T071 [US5] Implement `src/catalog/opds.ts` over `requestUrl` to satisfy T068
- [ ] T072 [US5] Implement `src/settings/credentials.ts` using `app.secretStorage` when present (1.11.4+) and a session-only prompt otherwise, never writing to the vault (FR-031a–d)
- [ ] T073 [US5] Refuse credentialed catalogs configured over an unencrypted connection (FR-031c)
- [ ] T074 [US5] Implement `src/catalog/search-modal.ts` for browsing, searching, and paging
- [ ] T075 [US5] Implement `src/catalog/download.ts` atomically — temp file, then note, then move — placing files via `getAvailablePathForAttachment()` (FR-032b)
- [ ] T076 [US5] Download remote covers into the vault at import and point the image property at the local file (FR-032a)
- [ ] T077 [US5] Implement duplicate detection warning before anything is written (FR-034)
- [ ] T078 [US5] Distinguish unreachable host, rejected credential, and unparseable response in error reporting (FR-035)
- [ ] T079 [US5] Verify quickstart scenario S5, including the mobile credential path

**Checkpoint**: Acquisition works without leaving the vault.

---

## Phase 8: User Story 6 — Mark places to return to (Priority: P6)

**Goal**: Bookmarks as typed entries reusing the highlight machinery.

**Independent Test**: Bookmark locations in both formats, confirm they persist, navigate, and appear only in the bookmarks tab.

- [ ] T080 [P] [US6] Write failing tests in `tests/unit/bookmark.test.ts` asserting bookmark entries share highlight anchoring and that each tab lists only its own kind (FR-028a, FR-028c)
- [ ] T081 [US6] Implement bookmark creation capturing the text at the location as anchor and label (FR-028b)
- [ ] T082 [US6] Implement `src/sidebar/bookmarks-view.ts` as a filtered view over the same entries
- [ ] T083 [US6] Reserve the `bookmark` type against collision with reader-configured types (FR-020a)
- [ ] T084 [US6] Verify quickstart scenario S6

**Checkpoint**: All six stories independently functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T085 [P] Implement keyboard navigation for the library grid — roving tabindex, arrows, Enter honouring modifiers, Home/End — and focus order across sidebar tabs (checklist ui CHK029)
- [ ] T086 [P] Ensure focus and hover are visually distinct and focus uses `:focus-visible` rather than a custom outline (ui CHK007)
- [ ] T087 [P] Verify right-to-left rendering and selection accuracy in both engines against the edge case in spec.md
- [ ] T088 [P] Confirm clean unload leaves zero timers, listeners, and injected styles (Principle II)
- [ ] T089 Measure the four constitutional budgets — 100 ms startup, 1 s first page, 60 fps, 500-book first screen in 2 s — and fix or revert any regression
- [ ] T090 Verify offline operation: everything except catalog search and download functions with networking disabled (FR-036, SC-011)
- [ ] T091 Test with a book carrying 200+ highlights to confirm the aggregate-record approach holds at realistic scale
- [ ] T092 [P] Write `README.md` covering setup, the property model, and the reader's configurable names
- [ ] T093 Confirm `manifest.json`, `versions.json`, and the release tag agree, and test against Obsidian 1.10.0 rather than only compiling against it

---

## Dependencies

### Phase dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**
- **User stories (Phases 3–8)**: all depend on Foundational only
- **Polish (Phase 9)**: depends on the stories being shipped

### Story dependencies

- **US1 (P1)**: independent. Delivers value alone.
- **US2 (P2)**: independent of US1 in code, though US1 supplies the natural entry point.
- **US3 (P3)**: needs US2's reader surface for selection and painting.
- **US4 (P4)**: needs US2's engines for table-of-contents extraction.
- **US5 (P5)**: fully independent — could be built first if acquisition mattered more.
- **US6 (P6)**: needs US3's entry machinery; nearly free once it exists.

### Within stories

Tests precede implementation, without exception (Principle III). Vendoring (T036, T037) precedes the adapters. The engine interface (T035) precedes both adapters. Entry parsing (T051) precedes the store, sidebar, and promotion.

## Parallel execution examples

**Phase 2**: T010 and T011 together.

**US1**: T017 and T018 together, then T019 and T020 together.

**US2**: T030, T031, and T032 together; later T038 and T039 together, since each adapter touches only its own directory.

**US5**: T068 and T069 together.

**Phase 9**: T085, T086, T087, T088, and T092 are all independent.

## Implementation strategy

**MVP first**: Setup → Foundational → US1 → **stop and validate**. That alone is a working library browser, which is the part no existing tool provides.

**True MVP**: add US2. "See my books, open one, come back later" is the loop the plugin exists for.

**Then increment**: US3 makes reading in Obsidian better than reading elsewhere. US4 is cheap. US5 removes the last reason to leave the vault. US6 is nearly free after US3.

**Severable**: US5 is the most self-contained subsystem — its own network handling, credentials, and failure modes. Cutting it from the first release removes the most risk per requirement dropped.
