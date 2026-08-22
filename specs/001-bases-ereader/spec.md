# Feature Specification: Bases-Backed E-Reader Library

**Feature Branch**: `001-bases-ereader`

**Created**: 2026-08-20

**Status**: Draft

**Input**: User description: "this plugin should act as a bases plugin view (maintaining the extensibility of .bases including the ability to add/remove properties, filter, sort, search, etc.), custom elements of the view should include a visual overlay indicating read/unread, reading progress as a percentage or a bar (selectable as property). to leverage the power of bases we can use notes as books marked as \"type: book\" in frontmatter which will populate the view (the property name and input are editable by user but this is default for the view). data for books are stored as frontmatter and can be imported from an OPDS (this includes metadata such as cover, ISBN, publish date, author, etc). the plugin comes with a separate popup OPDS search that allows a user to browse and download from a remote library. clicking on the thumbnail in the library view leads directly to the book (the books are stored as attachment files to the notes so that they can be moved anywhere and metadata can always be added without directly overwriting the file). in the reader view i am considering either importing the new pdf.js or using obsidian builtin depending on what fits my goals. the reader view should have highlight/search/reader selection (already builtin for pdfs but will need to be constructed for epub). the native open right sidebar should allow for 3 new tabs for the plugin: highlight & notes (where highlights/notes are viewed and can be clicked into; highlights and notes are stored as their own markdown files which attach via frontmatter to the book note and when deleted or changed on one end reflect that change in the other end book or note), outline (pull table of contents data from pdf or epub to populate the sidebar outline), bookmarks (still considering how to implement but these will host bookmarks for epubs/pdfs (depending on existing systems)). the inspirations for this project are popular e-readers and OPDS readers in obsidian, Third Mind Reader, and apple books. the idea is to simplify the process of reading while avoiding having to visit a third party solution to read books (like book orbit or calibre) and leveraging Obsidian's already clean and user friendly reading experience. the idea of the plugin is to feel as native as possible and robusticity for development. not inventing or reinventing every solution possible but using what exists within the obsidian ecosystem and native build rather than building a fancy or extensive app on top of obsidian."

## Clarifications

### Session 2026-08-20

- Q: Which storage shape should highlights use — one note per annotation, one annotations note per
  book, or PDF++'s model where a link in any note is the highlight? → A: A tiered model stored in the
  book note itself, which acts as the aggregate record for a book: metadata in frontmatter,
  highlights as blockquote entries in the body, following the same arrangement as Annotator. Each
  entry carries a block reference. A highlight may be left bare, given commentary in place, promoted
  to its own note that transcludes the entry rather than copying it, or cited into any other note by
  its block reference. Highlights are browsed in the sidebar tab rather than in Bases, so
  per-highlight Bases queryability is explicitly not a requirement.
- Q: When the same book is read on two devices and the vault syncs afterwards, which reading position
  should win? → A: Furthest position wins, offered rather than forced. A book opens at the position
  the local device left off at; when a further position is known, the reader is offered a single-step
  jump to it and may decline. Progress therefore never rewinds on its own, and a deliberate re-read
  is never hijacked. This requires tracking both a last-read position and a furthest-read position
  per book.
- Q: Which OPDS versions must the catalog search support in the first release — the Atom/XML 1.2
  feeds, the newer JSON 2.0 feeds, or both? → A: OPDS 1.2 only. OPDS 2.0 is an explicit non-goal for
  the first release. Every catalog server in common use serves 1.2, including those that also serve
  2.0, so a single parser reaches essentially the whole ecosystem today.
- Q: Where should credentials for a private catalog be kept, given that Obsidian's secret storage is
  per-device and doesn't reach mobile? → A: Obsidian's secret storage where it is available, and a
  once-per-session prompt where it is not. Credentials are never written into the vault under any
  circumstance, and no custom encryption scheme is used. Private catalogs therefore require
  re-entering credentials on mobile and on versions predating the API; public catalogs, which need no
  authentication, are unaffected.
- Q: How should bookmarks be stored, now that highlights are settled as anchored blockquote entries
  in the book note? → A: As a typed entry alongside highlights in the book note, sharing the same
  anchoring, block references, two-way deletion, and unanchored preservation. The bookmarks sidebar
  tab is a filtered view over the same entries. A bookmark captures the text at its location as its
  anchor and label, since anchoring is by quoted text rather than by coordinate.
- Q: Should the reader be split by format — PDFs opening in Obsidian's native viewer while EPUBs get
  a purpose-built reader — or should one engine handle both? → A: Superseded within the same session
  by the question below. Answered first as a split, then reopened once it emerged that Obsidian's
  bundled PDF engine is stale and carries documented defects in text selection and right-to-left
  rendering. Final answer: not split — the plugin provides the reader surface for both formats.
- Q: Which constraint should be relaxed to fix PDF reading — the 1 MB bundle cap, so a current PDF
  engine ships with the plugin, or the no-patching principle, so Obsidian's stale engine is patched?
  → A: Relax the bundle cap. The plugin bundles a current PDF rendering engine and renders both
  formats itself. Obsidian's viewer is neither patched nor depended upon, so Principle II stands
  unchanged and clean unload is preserved. This makes amending the constitution's 1 MB bundle limit a
  prerequisite for implementation. Rationale: patching a stale engine inherits its defects and adds
  breakage on every Obsidian release, whereas shipping a current engine addresses them at the root.

### Session 2026-08-20 (resolved during planning)

- Q: Does FR-037's prohibition on writes without a reader action forbid the debounced position writes
  the design depends on? → A: No, but the spec was contradictory and is now amended. FR-037 covers
  file lifecycle and note bodies; FR-037a exempts reading state in the open book's frontmatter,
  bounded to debounced writes that stop when the position stops changing; FR-037b forbids every other
  automatic write. SC-009 is restated as a ten-minute idle observation.
- Q: How long a context window should anchor an entry? → A: 32 characters of prefix and suffix,
  configurable. Long enough to disambiguate a repeated phrase in ordinary prose, short enough to
  survive light edits near the quote.
- Q: Where does a book open when its cover is selected? → A: In the current tab, honouring Obsidian's
  own modifier conventions for a new tab or a split, so the library behaves like any other file link.
- Q: How is tile size controlled? → A: Through the slider primitive Bases already provides, declared
  as a view option so it renders in the Bases toolbar and persists in the `.base` file. The plugin
  draws no settings UI of its own, and every other view setting uses a Bases option primitive too.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the whole library at a glance (Priority: P1)

A reader opens a saved library view and sees their books as a grid of cover thumbnails. Each cover
carries a visual indication of whether the book is unread, in progress, or finished, plus a progress
readout shown either as a percentage or as a bar. Because the view is a Bases view, the reader keeps
every capability they already know from Bases: choosing which properties are displayed, adding and
removing properties, filtering (for example, to unfinished books by a given author), sorting (by
recently read, publish date, or title), searching, and saving these arrangements as named views in a
`.bases` file that lives in their vault like any other file.

**Why this priority**: This is the surface the whole plugin is organized around and the only part
that must exist for anything else to have a home. It is also the piece that cannot be obtained from
existing tools — a reader can already open a PDF in Obsidian, but they cannot see their collection
with reading state layered onto it.

**Independent Test**: Create several notes carrying the book marker property and cover/author/progress
properties, point a Bases view at them, and confirm the grid renders with correct read state and
progress, and that filtering, sorting, searching, and property selection all behave as they do in any
other Bases view. Delivers a working library browser with no reader, no import, and no annotation.

**Acceptance Scenarios**:

1. **Given** a vault containing notes marked as books, **When** the reader selects the library view
   type in a Bases file, **Then** those notes appear as cover thumbnails and no other notes appear.
2. **Given** the library view is displayed, **When** the reader adds, removes, or reorders displayed
   properties, **Then** the change takes effect immediately and persists in the `.bases` file.
3. **Given** a progress property is bound and a book records 47%, **When** the view's progress display
   is set to "bar", **Then** the cover shows a bar filled to 47%; **When** it is set to "percentage",
   **Then** the cover shows "47%".
4. **Given** a book with no value for the bound progress property, **When** the library renders,
   **Then** no progress overlay appears on that cover and no read state is inferred from its absence.
5. **Given** no progress property is bound at all, **When** the library renders, **Then** no cover
   carries a progress overlay and the cards are otherwise unchanged.
6. **Given** the reader has changed the marker property from the default to a different property name
   and value in settings, **When** the library renders, **Then** membership is determined by the new
   marker and previously matching notes drop out.
7. **Given** a book note whose cover property is empty or points at a missing file, **When** the
   library renders, **Then** a readable placeholder showing title and author appears in place of the
   cover rather than a broken image.

---

### User Story 2 - Open a book and pick up where you left off (Priority: P2)

Clicking a cover in the library opens the book itself in a reader tab. The reader restores the exact
position the reader left off at, whether the book is a PDF or an EPUB. Reading advances a progress
value that flows back to the book note, so the library reflects it. The reader can select text,
search within the book, and adjust presentation for comfortable reading. Because the book file is an
attachment referenced by the note rather than something the plugin rewrites, the reader can move the
file anywhere in the vault without losing metadata or position.

**Why this priority**: Together with the library this forms the true minimum viable product — the
loop of "see my books, open one, come back later" is the reason the plugin exists. It is separated
from P1 because the library is independently useful and independently testable.

**Independent Test**: Open a PDF book and an EPUB book from the library, read partway, close, and
reopen; confirm position and progress restore correctly and the library tile updates. Delivers
reading without any annotation, outline, bookmark, or import capability.

**Acceptance Scenarios**:

1. **Given** a book note with an attached EPUB, **When** the reader clicks its cover, **Then** the
   book opens in a reader tab at the last-read position.
2. **Given** a book opened for the first time, **When** it renders, **Then** it opens at the
   beginning and is reported as 0% read.
3. **Given** a reader partway through a book, **When** they close the tab and reopen the book,
   **Then** the position is restored to the same location, and this holds for both EPUB and PDF.
4. **Given** a book file that has been moved to a different folder in the vault, **When** the reader
   opens the book note, **Then** the book still opens and retains its position and metadata.
5. **Given** an open book, **When** the reader searches for a phrase, **Then** matches are listed and
   selecting a match navigates to that location.
6. **Given** an open EPUB, **When** the reader selects text, **Then** the selection is preserved for
   copying and annotation in the same way selection behaves for PDFs.
7. **Given** a reader on a phone, **When** they open a book, **Then** the reader is usable with touch
   input at that viewport size.

---

### User Story 3 - Highlight and annotate as durable notes (Priority: P3)

While reading, the reader highlights a passage. Highlights for a book collect as entries in a
body of that book's note, each with a block reference, so they are ordinary vault content —
searchable, citable, and editable by hand. A highlight can be left bare, given commentary in place,
promoted into its own note when it deserves developing, or cited into any other note through its
block reference. A sidebar tab lists every highlight for the open book and can filter by type;
clicking one jumps to its location in the book. Editing the book note by hand is reflected in the
sidebar, and removing a highlight from either side removes it from both.

**Why this priority**: Annotation is what makes reading inside Obsidian more valuable than reading in
a dedicated e-reader, but the reading loop must work first.

**Independent Test**: Highlight passages in both an EPUB and a PDF, confirm entries appear in the
book note, edit one entry directly and see the sidebar update, promote one to its own
note, cite one in an unrelated note, and delete from each side confirming the counterpart is removed.
Delivers annotation without outline, bookmarks, or import.

**Acceptance Scenarios**:

1. **Given** an open book with no highlights yet, **When** the reader highlights a passage, **Then**
   an entry carrying the quoted text and a block reference is appended to the body of the book note,
   the book note's frontmatter is left unchanged, and the highlight appears in the book at that
   passage.
2. **Given** existing highlights, **When** the reader opens the highlights and notes sidebar tab,
   **Then** all highlights for the open book are listed in reading order.
3. **Given** a listed highlight, **When** the reader clicks it, **Then** the book navigates to that
   passage.
4. **Given** a highlight, **When** the reader adds commentary to it, **Then** the commentary is stored
   with that entry and neither the entry's location nor its block reference changes.
5. **Given** highlights carrying different types, **When** the reader filters the sidebar by a type,
   **Then** only highlights of that type are listed.
6. **Given** a highlight, **When** the reader promotes it to its own note, **Then** a note is created
   that links back to the book and the highlight and transcludes the quoted text rather than copying
   it, so editing the quote in the book note updates what the promoted note displays.
7. **Given** any highlight, **When** the reader cites its block reference in an unrelated note,
   **Then** the quoted text renders there through ordinary transclusion.
8. **Given** a book note edited directly in the editor, **When** the reader changes a highlight
   entry's text, **Then** the sidebar reflects the change without requiring a restart.
9. **Given** a highlight, **When** the reader deletes it from within the reader, **Then** its entry is
   removed from the body of the book note and the sidebar entry disappears.
10. **Given** a highlight entry removed directly from the book note, **When** the book is open,
    **Then** the highlight no longer renders in the book and the sidebar entry disappears.
11. **Given** a promoted highlight, **When** the reader deletes the underlying highlight, **Then**
    they are warned that a note depends on it before the deletion proceeds.
12. **Given** a book file that has been replaced with a different edition, **When** a highlight can
    no longer be located in the text, **Then** it is shown as unanchored with its quoted text
    preserved, and is never silently discarded.

---

### User Story 4 - Navigate by the book's own structure (Priority: P4)

The reader opens an outline sidebar tab and sees the book's table of contents as published in the
file — chapters and sections for an EPUB, the document outline for a PDF. Selecting an entry jumps
to that part of the book, and the entry corresponding to the current position is indicated.

**Why this priority**: Navigation materially improves long-form reading but the book is still fully
readable without it.

**Independent Test**: Open books of each format that carry a table of contents, confirm the outline
populates and navigation works, and confirm a book without a table of contents degrades gracefully.

**Acceptance Scenarios**:

1. **Given** an open book containing a table of contents, **When** the reader opens the outline tab,
   **Then** the contents render as a navigable, nested list.
2. **Given** the outline is displayed, **When** the reader selects an entry, **Then** the book
   navigates to that location.
3. **Given** the reader scrolls to a new chapter, **When** the outline is visible, **Then** the entry
   for the current location is indicated.
4. **Given** a book with no table of contents, **When** the outline tab is opened, **Then** an empty
   state explains that the book provides no contents rather than showing an error.

---

### User Story 5 - Find and add books without leaving Obsidian (Priority: P5)

The reader opens a search popup, queries a configured OPDS catalog, browses results with covers and
descriptions, and downloads a chosen book. The download produces a book note populated from the
catalog's metadata — cover, author, ISBN, publish date, description, and similar fields — with the
book file attached. The new book appears in the library view immediately.

**Why this priority**: Acquisition removes the last reason to visit an external tool, but a reader
can populate their library by hand or by moving files into the vault without it.

**Independent Test**: Configure a catalog, search, download a title, and confirm a complete book note
with attached file appears in the library. Delivers acquisition independently of annotation, outline,
and bookmarks.

**Acceptance Scenarios**:

1. **Given** a configured catalog, **When** the reader searches for a title, **Then** matching results
   are listed with cover, title, author, and available formats.
2. **Given** a result, **When** the reader downloads it, **Then** a book note is created carrying the
   catalog metadata and the downloaded file is attached to it.
3. **Given** a completed download, **When** the reader returns to the library view, **Then** the new
   book is present without a manual refresh.
4. **Given** a catalog that requires credentials on a platform providing secret storage, **When** the
   reader supplies them, **Then** they are kept outside the vault and reused on subsequent searches
   without being requested again.
5. **Given** the same catalog on a platform without secret storage, **When** the reader supplies
   credentials, **Then** they are used for the session, discarded at its end, and the reader is told
   at entry that they will be needed again.
6. **Given** the catalog is unreachable or returns an error, **When** the reader searches, **Then** a
   plain-language error is shown and no partial book note is left in the vault.
7. **Given** a book already in the library, **When** the reader downloads the same title again,
   **Then** they are warned about the duplicate before anything is written.
8. **Given** a download interrupted midway, **When** the reader retries or cancels, **Then** no
   partial file or orphaned note remains.

---

### User Story 6 - Mark places to return to (Priority: P6)

The reader marks a location in a book and later returns to it from a bookmarks sidebar tab, which
lists bookmarks for the open book with enough context to tell them apart. A bookmark is the same kind
of entry as a highlight, distinguished only by its type, so it is stored, anchored, cited, and
deleted the same way.

**Why this priority**: The smallest increment of the six, and the cheapest once highlights exist,
since it reuses their storage and anchoring entirely; progress restoration already covers the most
common "return to my place" need.

**Independent Test**: Create bookmarks in each format, confirm they list in the bookmarks tab and not
the highlights tab, navigate correctly, and survive closing and reopening the book.

**Acceptance Scenarios**:

1. **Given** an open book, **When** the reader bookmarks the current location, **Then** it appears in
   the bookmarks tab with a label identifying the location.
2. **Given** a bookmark, **When** the reader selects it, **Then** the book navigates to that location.
3. **Given** bookmarks exist, **When** the reader closes and reopens the book, **Then** the bookmarks
   are still present.
4. **Given** a bookmark, **When** the reader removes it, **Then** it disappears from the tab, its
   entry is removed from the book note, and the book is otherwise unchanged.
5. **Given** bookmarks and highlights in the same book, **When** the reader opens each sidebar tab,
   **Then** each tab lists only entries of its own kind.
6. **Given** a book file replaced with a different edition, **When** a bookmark's location can no
   longer be found, **Then** it is shown as unanchored with its captured text preserved.

---

### Edge Cases

- **Missing attachment**: a book note whose attached file has been deleted must still open its note,
  show its metadata, and explain that the file is missing rather than failing silently.
- **Moved or renamed file**: moving a book file anywhere in the vault must not break the note link,
  the reading position, or existing annotations.
- **Unsupported or corrupt file**: a file that cannot be parsed must produce a readable error naming
  the file, and must not prevent the rest of the library from rendering.
- **Copy-protected file**: a file that cannot be opened due to protection must be reported plainly as
  unsupported.
- **Very large books**: a several-hundred-megabyte PDF or an EPUB with thousands of sections must not
  freeze the interface while opening or while searching.
- **Large libraries**: a library several times larger than the 500-book performance budget must
  remain scrollable and filterable, degrading gradually rather than freezing.
- **Notes that are not books**: a note lacking the marker property must never appear in the library
  view, and a note carrying the marker but no attached file must appear as an entry without a
  readable file rather than being hidden.
- **Duplicate books**: two notes pointing at the same file, or two books sharing an ISBN, must both
  remain visible and be distinguishable.
- **Conflicting edits across devices**: when the same book's progress is advanced on two devices and
  the vault later syncs, highlights must not be lost, and the further of the two positions must become
  the furthest-read position rather than either silently overwriting the other.
- **Deliberate re-read**: when the reader restarts a book they have already finished, they must be
  able to decline the jump to their furthest position and keep reading from the beginning without
  being prompted again for that session.
- **Annotation whose anchor is lost**: covered by US3 scenario 7 — preserved as unanchored, never
  discarded.
- **Deleting a book note that has annotations**: the reader must be told how many annotations are
  attached before the deletion proceeds, since deleting the book note discards its highlights with
  it, and no promoted note may be left silently orphaned.
- **Reader-supplied property names**: if the reader points the plugin at a property name that
  collides with an unrelated existing property, the library must still render and must not overwrite
  the unrelated values.
- **Right-to-left and non-Latin text**: text direction and scripts declared by the book must render
  correctly and be selectable.
- **Offline use**: everything except catalog search and download must work with no network access.
- **Catalog serving an unsupported format**: a catalog that responds successfully but in a format the
  plugin cannot read must be reported as unsupported at configuration time, not as a failed search.
- **Mobile**: all six stories must be usable at phone viewport sizes with touch input, and a bundled
  rendering engine must not make the plugin fail to load or exhaust memory on a phone opening a large
  book.

## Requirements *(mandatory)*

### Functional Requirements

#### Library view

- **FR-001**: The plugin MUST provide a library view type selectable within a Bases file, so that the
  view is configured, saved, and shared through the reader's own `.bases` files.
- **FR-002**: The library view MUST preserve the Bases capabilities available to any other view:
  adding and removing displayed properties, filtering, sorting, searching, and saving named view
  configurations.
- **FR-003**: The library view MUST present books in the manner of Obsidian's built-in Cards view,
  rendering the properties the reader has chosen to display as that view renders them. Appearance
  beyond this is a matter for themes and CSS, not for the specification.
- **FR-003a**: The card image MUST come from a reader-selectable property, offered the same way the
  built-in Cards view offers it and defaulting to `cover`. Image rendering — fit, missing values,
  and load behaviour — is the Cards view's, and the plugin MUST NOT substitute its own.
- **FR-004** *(revised)*: The library view MUST render a read-state badge on a book's cover derived
  from its reading progress: no progress recorded ⇒ no badge, 0 ⇒ unread, above 0 and below 100 ⇒
  reading, 100 ⇒ finished. The view MUST NOT scope a separate read-state property.
  *Superseded the original requirement, which scoped a `read-state` property of its own and forbade
  deriving it from progress. That property duplicated what progress already recorded, nothing ever
  wrote it, and the reader kept their own status field for workflow. The prohibition existed to stop
  a user-owned property being silently overwritten by a guess; with no such property, the badge is
  openly a second rendering of the same number rather than a claim about a field of its own.*
- **FR-005**: The library view MUST scope a reading-progress property, and MUST allow the reader to
  choose which property supplies it. Where the property is bound and a book has a value, the view MUST
  render it as an overlay on the cover in a reader-selectable form, at minimum a percentage and a bar.
  Where it is unbound or the book has no value, no overlay is rendered.
- **FR-005a**: Only the properties this view scopes render as overlays. Every other displayed property
  renders exactly as it does in the built-in Cards view.
- **FR-006**: The library view MUST determine membership from a marker property whose name and
  expected value are reader-configurable, defaulting to the property `type` with the value `book`.
- **FR-007**: Selecting a book's cover MUST open that book in the reader, replacing the current tab,
  and MUST honour the same modifier conventions Obsidian applies to file links — a modified click
  opens a new tab, and a further modifier opens a split.
- **FR-007a**: The library view MUST honour the reader's grouping configuration, rendering grouped
  results when a grouping is set and a single ungrouped set when it is not.
- **FR-008**: A book whose image property is empty or unresolvable MUST render however the built-in
  Cards view renders that case. The plugin MUST NOT add a placeholder of its own.
- **FR-008a**: Everything the view does not scope — card layout, sizing, property display, grouped
  presentation, cover loading, and behaviour when no results match — MUST follow the built-in Cards
  view. The plugin MUST NOT substitute its own design for any of it.
- **FR-008b**: Card sizing MUST be reader-adjustable through a control supplied by Bases itself rather
  than one the plugin draws, mirroring the equivalent setting on the built-in Cards view, and MUST
  persist in the `.base` file.
- **FR-008c**: Every view setting the plugin adds MUST be declared through the option primitives Bases
  provides, so the library's settings appear and behave like those of any built-in view.
- **FR-008d**: The default rendering of the read-state overlay MUST be distinguishable by more than
  colour alone.

#### Books and metadata

- **FR-009**: A book MUST be represented by a markdown note whose frontmatter carries its metadata,
  with the book file held as an attachment referenced by that note.
- **FR-010**: The plugin MUST NOT modify the bytes of an attached book file. All metadata added by
  the reader or by an import MUST be written to the note, never into the book file.
- **FR-011**: Moving or renaming a book file within the vault MUST NOT break the note's reference to
  it, its reading position, or its annotations.
- **FR-012**: The plugin MUST support EPUB and PDF book files.
- **FR-013**: The plugin MUST record, at minimum, cover, title, author, publish date, and description
  as book note properties when those values are available. The cover MUST be written into the image
  property, so that a manually created book and an imported one are indistinguishable in structure.
- **FR-013a**: A book note MUST support more than one attached file. Where several are readable, the
  reader view MUST open the most recently read of them, and MUST ask when there is no such record.

#### Reading

- **FR-014**: Opening a book MUST present it in a reader surface appropriate to its format and
  restore the last-read position, for both EPUB and PDF.
- **FR-014a**: The plugin MUST render both formats in reader surfaces it provides, bundling a current
  PDF rendering engine rather than relying on the one embedded in Obsidian.
- **FR-014b**: The plugin MUST NOT patch, subclass, monkey-patch, or read the internals of Obsidian's
  own PDF viewer, and MUST NOT depend on any other plugin being installed. Its reader MUST continue
  to work if Obsidian's viewer changes.
- **FR-014e**: The reader view MUST be bound to the book note as its active file, so that Obsidian's
  own sidebar surfaces — file properties, backlinks, outgoing links, and search — operate on the book
  note while reading, without the plugin providing substitutes for any of them.
- **FR-014c**: The plugin MUST NOT claim the vault-wide association for PDF files by default. Books
  MUST open in the plugin's reader when opened from the library, while files opened elsewhere in the
  vault continue to use whatever Obsidian would otherwise use. Taking over the association MUST be an
  explicit opt-in that can be cleanly reversed when the plugin is disabled.
- **FR-014d**: Bundled rendering engines MUST NOT be loaded or parsed during plugin startup. They
  MUST be loaded on first use, so that the constitution's startup budget is met whether or not the
  reader opens a book in a session.
- **FR-015**: The reader view MUST update a reading progress value as the reader advances, and that
  value MUST be readable by the library view.
- **FR-015a**: Each book MUST record both a last-read position and a furthest-read position as note
  properties. The furthest-read position MUST only ever advance, except when the reader explicitly
  resets it.
- **FR-015d**: Reading position MUST be recorded against the book note, not against a file path held
  in plugin data, so that moving or renaming a book file cannot orphan it (FR-011).
- **FR-015b**: On opening a book, the reader view MUST restore the last-read position. When a
  furthest-read position lies beyond it, the reader view MUST offer a single-step jump to that
  position and MUST NOT navigate there unless the reader accepts. Declining MUST NOT alter either
  recorded position.
- **FR-015c**: Reading position MUST NOT be rewound by synchronisation. Where two devices report
  different positions for the same book, the further one MUST become the furthest-read position.
- **FR-016**: Both formats MUST support text selection, in-book search with navigable results, and
  creation of highlights, provided by the plugin's own reader surfaces and behaving equivalently
  across formats.
- **FR-016a**: Text selection MUST be accurate to the character, including where a selection begins
  or ends partway through a word, and MUST behave correctly for right-to-left scripts.
- **FR-016b**: Highlights MUST be rendered in the book as the reader reads, for both formats, rather
  than being visible only when navigated to.
- **FR-016c**: Highlight entries MUST be the same kind of entry in the book note for both formats, so
  that the sidebar, filtering, promotion, citation, and deletion behave identically regardless of
  format.
- **FR-017**: The plugin's readers MUST offer at minimum a text-size control for reflowable books and
  a zoom control for fixed-page books, and MUST render using the reader's active Obsidian theme
  colors rather than imposing their own appearance.
- **FR-018** *(revised)*: A book reads as finished once its reading progress reaches 100, which the
  reader view records as it reads. There is no separate read state to set manually.
  *Superseded alongside FR-004: with read state derived from progress, "mark as finished" and "set
  manually" no longer name anything that exists.*

#### Annotations

- **FR-019**: Highlights for a book MUST be stored as entries in the body of that book's note, which
  serves as the aggregate record for the book. Each entry MUST carry a block reference so it can be
  addressed individually. Writing a highlight MUST NOT alter the book note's frontmatter.
- **FR-020**: Each highlight entry MUST retain the quoted source text together with enough
  surrounding context to re-locate the passage by search, for both formats, so the highlight survives
  independently of the book file. Entries MAY additionally record a format-appropriate location hint,
  such as a page number, provided the quoted text remains the authoritative anchor.
- **FR-020a**: An entry MUST carry a type. Highlight types MUST be chosen by the reader from a
  configurable set, and the sidebar MUST allow filtering the open book's highlights by type. Bookmark
  is a reserved type, described in FR-028a.
- **FR-021**: A sidebar tab MUST list the annotations for the open book in reading order, and
  selecting one MUST navigate the book to that passage.
- **FR-021a**: The plugin's sidebar surfaces MUST read from the book note, so their contents remain
  visible and editable as ordinary note content rather than existing only inside the plugin.
- **FR-022**: Changes made to highlight entries in the book note MUST be reflected in the reader and
  sidebar without requiring a restart, and changes made in the reader MUST be written to the book
  note.
- **FR-022a**: A reader MUST be able to add commentary to a highlight in place, without changing how
  or where the highlight is stored.
- **FR-022b**: A reader MUST be able to promote a highlight to its own note. The promoted note MUST
  link back to the book and the highlight entry, and MUST transclude the highlight rather than copy
  its quoted text, so the quote and its anchor retain exactly one source of truth.
- **FR-022c**: Any highlight MUST be citable from any other note through its block reference,
  whether or not it has been promoted, using ordinary Obsidian transclusion.
- **FR-023**: Deleting a highlight from either the reader or the book note MUST remove it from both.
  Deleting a book note or a promoted note MUST route through the vault's trash so it remains
  recoverable, and MUST never hard-delete. Deleting a highlight that has been promoted MUST warn that
  a note depends on it before proceeding.
- **FR-024**: An annotation whose location can no longer be resolved in the book MUST be preserved and
  presented as unanchored rather than discarded.

#### Outline

- **FR-025**: A sidebar tab MUST present the table of contents declared by the open book file, nested
  as the file declares it, whenever the file provides one.
- **FR-025a**: Where the book file declares no table of contents, the outline MUST fall back to the
  structure of the book note itself.
- **FR-026**: Selecting an outline entry MUST navigate the book to that location, and the entry
  matching the current position MUST be indicated.
- **FR-027**: Where neither the book file nor the book note provides any structure, the outline MUST
  produce an explanatory empty state.

#### Bookmarks

- **FR-028**: A sidebar tab MUST allow the reader to mark and return to locations within the open
  book, listing each bookmark with a label identifying its location, for both EPUB and PDF.
- **FR-028a**: A bookmark MUST be stored as an entry in the book note of the same kind as a highlight,
  distinguished by its type, and MUST therefore share the anchoring, block referencing, two-way
  deletion, and unanchored-preservation behaviour required of highlights by FR-019 through FR-024.
- **FR-028b**: A bookmark MUST capture the text at its location to serve as its label, and MUST be
  anchored by the same means as a highlight, so that it remains locatable when the book file is
  edited or replaced.
- **FR-028c**: The bookmarks tab MUST present only entries of bookmark type, and the highlights tab
  MUST NOT list them.
- **FR-029**: Bookmarks MUST persist across closing and reopening a book and across restarting the
  application.

#### Catalog search and import

- **FR-030**: The plugin MUST provide a popup through which the reader searches and browses a
  configured remote catalog and downloads books from it.
- **FR-030a**: The plugin MUST support catalogs served as OPDS 1.2 Atom feeds, including navigation
  between feed levels, catalog-provided search, and paged result sets.
- **FR-030b**: A catalog the plugin cannot read — including one serving only OPDS 2.0 — MUST be
  reported as unsupported, naming the reason, at the point the reader configures or opens it rather
  than failing silently during a search.
- **FR-031**: The reader MUST be able to configure one or more catalogs, including credentials where
  the catalog requires them.
- **FR-031a**: Catalog credentials MUST NOT be written into the vault, into any note, or into plugin
  data under any circumstance. Where the platform provides secret storage, credentials MUST be kept
  there; where it does not, they MUST be held only for the current session and discarded afterwards.
- **FR-031b**: The plugin MUST NOT implement its own encryption for credentials, since any key it
  could store would travel with the data it protects.
- **FR-031c**: Credentials MUST be transmitted only over an encrypted connection. A catalog
  configured with credentials over an unencrypted connection MUST be refused with an explanation.
- **FR-031d**: Where credentials cannot be persisted on the current platform, the reader MUST be told
  that they will be needed again next session, at the point of entry rather than on failure.
- **FR-032**: Downloading MUST create a book note populated from the catalog's metadata with the
  downloaded file attached, and the result MUST appear in the library without a manual refresh.
- **FR-032a**: A remote cover image MUST be downloaded into the vault at import and the image property
  set to the local file, so covers render offline and no third-party host learns which books the
  reader owns.
- **FR-032b**: Downloaded book files and cover images MUST be placed using Obsidian's own attachment
  path handling, so they land wherever the vault is already configured to put attachments and so
  naming and collisions behave as they do everywhere else. The plugin MUST NOT introduce its own
  folder setting to duplicate one Obsidian already provides.
- **FR-033**: A failed, cancelled, or interrupted download MUST leave no partial file and no orphaned
  note in the vault.
- **FR-034**: The plugin MUST warn before creating a book that duplicates one already in the library.
- **FR-035**: Catalog errors MUST be reported in plain language naming what failed, distinguishing at
  minimum an unreachable server, a rejected credential, and a response the plugin cannot parse.

#### Cross-cutting

- **FR-036**: Every capability except catalog search and download MUST function with no network
  access.
- **FR-037**: The plugin MUST NOT create, move, rename, or delete any note or attachment, and MUST
  NOT alter the body of any note, except as the direct result of a reader action.
- **FR-037a**: Reading state — position, progress, and read state in a book note's frontmatter — is
  exempt from FR-037 and MAY be written as a consequence of the reader reading. Such writes MUST be
  confined to the frontmatter of the book currently open, MUST be debounced to natural boundaries
  rather than made continuously, and MUST NOT occur while the reader's position is unchanged.
- **FR-037b**: No other automatic write is permitted. In particular the plugin MUST NOT rewrite,
  reformat, reorder, or normalise any note it did not just change on the reader's behalf.
- **FR-038**: All six user stories MUST be usable on mobile at phone viewport sizes with touch input.
- **FR-039**: The plugin MUST NOT transmit reading activity, library contents, or annotations to any
  destination other than a catalog the reader explicitly configured.

### Key Entities

- **Book**: a note representing one book, and the aggregate record for it. Its frontmatter carries
  the marker property that includes it in the library, descriptive metadata (title, author, cover,
  ISBN, publish date, description), reading state (read/unread/finished, progress, last position),
  and a reference to its book file. Its body holds that book's highlight entries. Owns zero or more
  highlights and bookmarks.
- **Book file**: the EPUB or PDF attachment a book note points at. Treated as read-only content that
  may live anywhere in the vault.
- **Highlight**: an entry in the body of a book note. Carries quoted source text, surrounding
  context sufficient to re-locate it, an optional type or colour, optional inline commentary, and a
  block reference addressing it. May be unanchored if its location can no longer be resolved, and may
  be promoted without changing where it is stored.
- **Promoted note**: a note developed from a single highlight. Owns its own commentary and links back
  to the book note and the highlight entry, transcluding rather than duplicating the quoted text.
- **Bookmark**: an entry of bookmark type in a book note, structurally identical to a highlight but
  carrying no commentary. Captures the text at its location as both anchor and label.
- **Reading position**: where the reader left off in a book, expressed so it survives the file being
  moved and reopened on another device. Each book carries two: a last-read position, which follows
  the reader in both directions, and a furthest-read position, which only advances.
- **Catalog**: a configured remote source of books served as an OPDS 1.2 Atom feed, with an address
  and optional credentials held outside the vault. May contain nested navigation feeds and its own
  search endpoint.
- **Library view configuration**: the reader's saved arrangement of the library — which properties
  show, which supplies progress, how progress renders, and the marker that defines membership.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A library of 500 books renders its first screen within 2 seconds and scrolls smoothly
  at 60 frames per second on both desktop and mobile.
- **SC-002**: Opening a book from the library presents its first readable page within 1 second.
- **SC-003**: Reading position is restored to the same location on reopening in 100% of cases across
  both supported formats, including after the book file has been moved within the vault.
- **SC-003a**: Reading progress never moves backwards without the reader choosing it, including after
  synchronising a vault edited on another device.
- **SC-004**: Progress shown in the library agrees with the position in the reader to within one
  percentage point.
- **SC-005**: A reader can go from opening the catalog search to having a readable book in their
  library in under 60 seconds and no more than five interactions.
- **SC-006**: 100% of annotations remain listed and navigable after restarting the application, and
  no annotation is ever lost without the reader deleting it.
- **SC-007**: Every filter, sort, search, and property arrangement a reader can apply to a built-in
  Bases view produces equivalent results in the library view.
- **SC-008**: All six user stories are completable on a phone-sized viewport using touch alone.
- **SC-009**: With a book open and the reader's position unchanged, zero vault writes occur over a
  ten-minute idle observation. Writes during active reading are confined to the open book's
  frontmatter and occur at debounce boundaries, never continuously.
- **SC-010**: A reader who already keeps books in their vault can adopt the library view without
  editing any existing note, provided their notes carry a marker property they can point the view at.
- **SC-011**: With networking disabled, every capability except catalog search and download continues
  to function.

## Assumptions

- **Bases is available**: the reader is running a version of Obsidian where Bases is present and
  enabled. The library view is a Bases view type and does not provide a standalone fallback.
- **Books already in the vault**: readers may populate their library by creating notes by hand or by
  moving files into the vault; catalog import is one path to a book note, not the only one.
- **One file per book**: a book note references a single book file. Multi-file or multi-volume books
  are out of scope.
- **Progress is a note property**: reading progress and read state live in the book note's
  frontmatter so that Bases can filter and sort on them, rather than in private plugin storage that
  Bases cannot see.
- **Position updates are debounced**: reading position is written on natural boundaries — closing the
  book, switching away, or a pause in reading — rather than continuously, to keep the vault quiet and
  avoid sync churn.
- **Covers come from the book note**: the cover shown in the library is whatever the cover property
  points at, so readers can replace a cover by editing the note.
- **Highlights are browsed in the sidebar, not in Bases**: individual highlights are blocks rather
  than notes, so they are deliberately not filterable or sortable as Bases rows. Promoted notes are
  ordinary notes and therefore are.
- **Anchoring is by quoted text**: a highlight is re-located by searching the book for its quoted
  text disambiguated by surrounding context, rather than by a format-specific coordinate. This
  degrades gracefully when the book file is edited or replaced with another edition.
- **English-language interface for the first release**, with book content itself rendered in whatever
  language and text direction the book declares.
- **No digital rights management**: copy-protected files are out of scope and are reported as
  unsupported.
- **Secret storage is per-device and not universal**: Obsidian's secret storage was introduced in
  1.11.4, does not synchronise between devices, and is not available on mobile. The specification
  treats a session-only prompt as the normal experience on those platforms rather than as a failure,
  and does not claim credentials are encrypted at rest.
- **OPDS 2.0 is out of scope for the first release**: the JSON-based 2.0 format is deliberately not
  supported. Catalogs serving only 2.0 are reported as unsupported. This is revisitable without
  affecting anything else in the specification.
- **No reading statistics**: streaks, session timers, and reading-time analytics are out of scope.
- **Single-reader vault**: no sharing, multi-user, or permission model.
- **The plugin owns both reader surfaces**: it bundles a current PDF rendering engine and provides
  its own EPUB reader, rather than building on Obsidian's embedded PDF viewer. This was chosen after
  finding that Obsidian's bundled engine is materially behind upstream and carries documented defects
  in text selection accuracy and right-to-left rendering, with no committed timeline for updating it.
- **The constitution's bundle cap has been amended to accommodate this**: constitution v1.1.0 replaces
  the flat 1 MB limit with a two-tier one — the plugin's own compiled code stays under 1 MB, vendored
  rendering engines are capped at 5 MB combined, and the total shipped plugin must not exceed 6 MB.
  The exemption applies only to an engine loaded on first use, which is why FR-014d exists. Principle
  II was deliberately left unamended and remains binding: the approach chosen here does not patch or
  read Obsidian's internals.
- **Bundled engines must be redistributable**: any rendering engine adopted MUST carry a licence
  compatible with redistribution, as the constitution already requires of runtime dependencies.
- **Which specific rendering libraries are used remains a planning decision**, constrained by the
  accuracy, right-to-left, and platform-parity requirements above.
