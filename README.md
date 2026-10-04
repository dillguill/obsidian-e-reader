# E-Reader

Read EPUBs and PDFs inside Obsidian, with a library built on Bases and
highlights that live in your notes as ordinary markdown.

## What it does

**Library.** A Bases view called `Library`, so your book collection is a real
Bases query — your filters, your sort, your grouping. It reads the same
configuration keys as the built-in Cards view (`image`, `imageFit`,
`imageAspectRatio`, `cardSize`), so an existing `.base` keeps working, and
shows where you are in each book: a clean cover until a book is opened, a
fade with the percentage and a thin bar while it is underway, and a small
check once it is finished. These bind themselves to whatever property the
reader writes, so a plain `.base` shows them without any setup. Books without
a cover get one drawn from their title, and right-clicking or long-pressing a
card opens it, opens its note, or marks it finished or unread.

**Import.** Drop an EPUB or PDF onto the Library, set an inbox folder, or run
"Import a book from the vault". EPUBs landing in the inbox are imported
straight away; PDFs, which are as often papers or receipts as books, wait
until you tick the ones that are books. The
title, author, language, cover and more are read from the file itself, and
Open Library can fill in what the file does not say (ISBN, page count,
subjects, a cover). The note goes to your book notes folder (`Library` by
default) and the file to wherever Obsidian puts attachments, or a folder you
choose. A book already in the library is never imported twice: the same
ISBN, or the same title (subtitle aside) by the same author, or by anyone when
the existing note has no author. A failed import leaves nothing behind.
**Find duplicate books** lists books that are in the library more than once
and merges each into the note you keep, moving highlights, properties and
text and trashing the rest.

**Wishlist and read later.** "Add a book to the wishlist" searches Open
Library, then lets you pick a cover from the book's editions (or an image in
your vault) and tick which details become properties; either step can be
skipped. It saves a book note with those but no file. A card's menu also has
**Change cover…**, which can send the replaced image to the trash, and
**Update details…**, which looks the book up again and writes only what you
tick. In the
library it shows faded and labelled *Wishlist*; opening it offers **Add
file…**, and importing the book later (by drop, inbox or command) fills that
same note instead of making a second one. **Read later** and **Add to
wishlist** in a card's menu add a status to the note: a `read-later` or
`wishlist` tag by default, or values in a list property you choose in
settings. Read later puts a bookmark on the cover; filter a Bases view on the
status for a reading queue. Reading progress is tracked separately.

**Reader.** EPUB and PDF, both remembering where you were, with a toolbar
that is the same on desktop and phone: previous and next page buttons around a
page box you can type into (a page number for PDFs, a percentage for EPUBs),
then search, reading settings and a button that opens the contents. PDFs offer
fit-to-width, fit-to-height and two-page spreads, and are inverted to match a
dark vault; EPUBs
offer scrolled or paginated reading (two pages side by side on a wide pane, or
always one), tap the edge of a page to turn it, and render in your vault's own
theme rather than whatever the book shipped with. The reader reports the book
note as its file, so Obsidian's own Properties pane and everything else that
follows the active file work on it unchanged.

**Reading settings** (the **Aa** button) choose a theme for the page — match
Obsidian, Light, Sepia or Dark — the zoom or text size, the layout (PDF fit
and spreads, EPUB flow and two-page spreads) and, for EPUBs, the font (the book's own, your
Obsidian font, a serif or a sans), text size, line spacing, margins,
justification and hyphenation.

**Search** (the search button, or Cmd/Ctrl-F in the reader) finds every match
in the book as you type, listed with its page or chapter; pick one, or step
through them with Enter and Shift-Enter, and the match is marked on the page.
Jumping anywhere — a search result, a contents entry, a link, a typed page —
leaves a **Back to …** button that returns you to where you were reading.

Under the page, a footer shows the chapter, the time left in it, and how far
through the book you are, with a progress bar marked where each chapter
starts. The time is learned from how fast you actually turn pages. Turn it off
in reading settings. Opening a book you had read further in elsewhere offers
to jump to the furthest page you reached.

Pinch zooms on a touchscreen. On any touchscreen a tap in the
middle of the page hides the toolbar for distraction-free reading and brings
it back.

The left and right arrow keys and Page Up/Page Down turn the page, and **Next
page**, **Previous page**, **Zoom in**, **Zoom out** and **Show or hide the
reader toolbar** are commands you can bind to any hotkey.

**Highlights and notes.** Select text and a small bar opens beside it: tap a
colour to highlight as that type, or copy the text. Right-click works too, and
the **Highlight selection** command repeats the last type you chose. Saved highlights are painted back into the
book in the colour of their type, and right-clicking one offers to recolour,
copy or delete it. Each is written into the book note as a callout you can
read, edit and link to:

```markdown
> [!idea]
> the spice must flow
> – [Dune, Book One, p. 35](obsidian://e-reader?vault=…&id=h-a1b2c3)
> %%{"id":"h-a1b2c3","section":"Book One","created":"2026-08-20T10:04:00Z"}%%
>
> Worth comparing to the guild's monopoly argument.

^h-a1b2c3
```

The callout's type is the highlight's type, so a CSS snippet can give each type
its own callout style, and the source line under the quote opens the book at that
highlight. The quote is the anchor as well as the display, so editing it by
hand edits the anchor. Everything outside the plugin's `%%e-reader:begin/end%%`
markers is yours and is never touched. Nothing lives in a sidecar database.

**Using a highlight elsewhere.** The book note is the one place highlights
are kept. From a highlight's menu, in the reader or the Highlights pane:

- **Copy as quote** or **Copy as callout** copies the quote with its source
  line and a `[[Book#^id|View in book note]]` beside it, then your comment.
- **Copy link** copies `[[Book#^id]]`.
- **Export as note** creates a note of its own, named after the quote's
  opening words, with book, type, chapter, page and created properties (names and
  folder in settings). Its body is the quote copy by default; set a
  **Template** in settings to lay it out yourself with `{{highlight}}`,
  `{{quote}}`, `{{comment}}`, `{{link}}`, `{{source}}`, `{{book}}`,
  `{{chapter}}`, `{{page}}`, `{{type}}` and `{{created}}`. It is a starting
  point for your own thoughts, not a second copy the plugin keeps in sync.

**Open in book** (a command, and in an exported note's file menu) opens the
reader at that highlight. **Rename a highlight type** renames it in settings
and in every book.

**Bookmarks** are a `bookmarks` list property on the book note, one position
per item.

**Outline.** The book's own table of contents, nested, with the current
section tracking as you read. It falls back to a note's markdown headings when
the file has no contents of its own, so it covers ordinary notes too —
filter, collapse, and follow-cursor included.

## Installing

Until this is in the community catalogue, install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install BRAT from Community plugins.
2. **Add beta plugin**, and give it this repository.
3. Enable **E-Reader** in Community plugins.

BRAT will keep it up to date as releases are published.

## Setting up a library

A book is a note. Give it an attachment and, if you like, a cover:

```markdown
---
type: book
title: Tao Te Ching
author: Lao Tzu
cover: _attachments/tao-te-ching.jpg
attachments:
  - "[[Tao Te Ching - Lao Tzu.epub]]"
---
```

`type: book` is what marks it. The plugin writes only to notes carrying that
marker, and both the property name and the value are configurable.

Then create a base, add a view, and choose **Library** as its type. Clicking a
cover opens the book.

The reader writes back only `reading_progress` (0-100), `reading_position`
(where you left off) and `furthest_position` (the furthest you have read,
which only moves forward), and only while you are reading. A book opens where
you left off; if you read further elsewhere, for example on another device,
a bar offers to jump there. **Mark as unread** on a library card clears all
three. The names are configurable in settings, along with the properties the plugin reads and the
highlight types and their colours.

## Building

```sh
npm install
npm test
npm run build
```

`npm run build` type-checks, bundles to `main.js`, and fails if the bundle
grows past the size the project holds itself to.

## License

MIT. See [LICENSE](LICENSE).
