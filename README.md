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
choose. A book already in the library is never imported twice, and a failed
import leaves nothing behind.

**Wishlist and read later.** "Add a book to the wishlist" searches Open
Library and saves a book note with its details and cover but no file. In the
library it shows faded and labelled *Wishlist*; opening it offers **Add
file…**, and importing the book later (by drop, inbox or command) fills that
same note instead of making a second one. **Read later** in a card's menu
ticks a `read_later` property and puts a bookmark on the cover; filter a
Bases view on it for a reading queue.

**Reader.** EPUB and PDF, both remembering where you were, with a toolbar
shaped like Obsidian's own PDF viewer: zoom or text size, a display menu, and
a page box you can type into. PDFs offer fit-to-width, fit-to-height, two-page
spreads and a dark-theme mode; EPUBs offer scrolled or paginated reading, tap
the edge of a page to turn it, and render in your vault's own theme rather
than whatever the book shipped with. The reader reports the book note as its
file, so Obsidian's own Properties pane and everything else that follows the
active file work on it unchanged.

The left and right arrow keys and Page Up/Page Down turn the page, and **Next
page**, **Previous page**, **Zoom in** and **Zoom out** are commands you can
bind to any hotkey.

**Highlights and notes.** Select text and a small bar opens beside it: tap a
colour to highlight as that type, or copy the text. Right-click works too, and
the **Highlight selection** command repeats the last type you chose. Saved highlights are painted back into the
book in the colour of their type, and right-clicking one offers to recolour,
copy or delete it. Each is written into the book note as a callout you can
read, edit and link to:

```markdown
> [!idea] Idea · [p. 35](obsidian://e-reader?vault=…&id=h-a1b2c3)
> the spice must flow
> %%{"id":"h-a1b2c3","created":"2026-08-20T10:04:00Z"}%%
>
> Worth comparing to the guild's monopoly argument.

^h-a1b2c3
```

The callout's type is the highlight's type, so a CSS snippet can give each type
its own callout style, and the link in its title opens the book at that
highlight. The quote is the anchor as well as the display, so editing it by
hand edits the anchor. Everything outside the plugin's `%%e-reader:begin/end%%`
markers is yours and is never touched. Nothing lives in a sidecar database.

**Using a highlight elsewhere.** The book note is the one place highlights
are kept. From a highlight's menu, in the reader or the Highlights pane:

- **Copy as quote** or **Copy as callout** copies the text with a link back to
  the highlight, to paste into any note.
- **Copy link** copies `[[Book#^id]]`.
- **Export as note** creates a note of its own: the quote, a link back, and
  properties (book, type, page, created; names and folder in settings) that
  Bases can list. It is a starting point for your own thoughts, not a second
  copy the plugin keeps in sync.

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
