# E-Reader

Read EPUBs and PDFs inside Obsidian, with a library built on Bases and
highlights that live in your notes as ordinary markdown.

## What it does

**Library.** A Bases view called `Library`, so your book collection is a real
Bases query — your filters, your sort, your grouping. It reads the same
configuration keys as the built-in Cards view (`image`, `imageFit`,
`imageAspectRatio`, `cardSize`), so an existing `.base` keeps working, and
adds a progress overlay — a bar or a percentage — plus a read-state badge
derived from it: unread until a book is opened, reading while it is underway,
finished at the end. Both bind themselves to whatever property the reader
writes, so a plain `.base` shows them without any setup.

**Reader.** EPUB and PDF, both remembering where you were, with a toolbar
shaped like Obsidian's own PDF viewer: zoom or text size, a display menu, and
a page box you can type into. PDFs offer fit-to-width, fit-to-height, two-page
spreads and a dark-theme mode; EPUBs offer scrolled or paginated reading, tap
the edge of a page to turn it, and render in your vault's own theme rather
than whatever the book shipped with. The reader reports the book note as its
file, so Obsidian's own Properties pane and everything else that follows the
active file work on it unchanged.

**Highlights and notes.** Select text and right-click, or arm highlight mode
from the toolbar and simply drag. Saved highlights are painted back into the
book in the colour of their type, and right-clicking one offers to recolour,
copy or delete it. Each is written into the book note as a callout you can
read, edit and link to:

```markdown
> [!quote] idea
> ==the spice must flow==
> %%{"id":"h-a1b2c3","created":"2026-08-20T10:04:00Z"}%%
>
> Worth comparing to the guild's monopoly argument.

^h-a1b2c3
```

The quote is the anchor as well as the display, so editing it by hand edits
the anchor. Everything outside the plugin's `%%e-reader:begin/end%%` markers
is yours and is never touched. Nothing lives in a sidecar database.

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

The reader writes back only `reading_progress` (0-100) and `reading_position`
(where you left off), and only while you are reading. Both names are
configurable in settings, along with the properties the plugin reads and the
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
