# E-Reader

Read EPUBs and PDFs inside Obsidian, with a library built on Bases and
highlights that live in your notes as ordinary markdown.

## What it does

**Library.** A Bases view called `Library`, so your book collection is a real
Bases query — your filters, your sort, your grouping. It reads the same
configuration keys as the built-in Cards view (`image`, `imageFit`,
`imageAspectRatio`, `cardSize`), so an existing `.base` keeps working, and
adds optional overlays for a read-state and a progress property. Bind them and
they appear; leave them unbound and nothing is drawn. Neither is ever inferred.

**Reader.** EPUB and PDF, both scrolling continuously, both remembering where
you were. The reader reports the book note as its file, so Obsidian's own
Properties pane and everything else that follows the active file work on it
unchanged.

**Highlights and notes.** Select text, right-click, pick a type. The highlight
is written into the book note as a callout you can read, edit and link to:

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
read-state: reading
---
```

Then create a base, add a view, and choose **Library** as its type. Clicking a
cover opens the book.

The reader writes back only `progress` and `last-read`, and only while you are
reading.

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
