# foliate-js (vendored subset)

`search.js` and `text-walker.js` from [foliate-js](https://github.com/johnfactotum/foliate-js),
MIT, John Factotum. Pinned at `78914aef4466eb960965702401634c2cb348e9b1`.

## Why vendored rather than a dependency

The author does not publish to npm. The `foliate-js` package on the registry is a
third-party republish by an unrelated account, so taking it from there would mean
trusting a mirror nobody upstream controls. The project's own research (R2) called
for vendoring a pinned commit, and this is that.

## Why only these two files

foliate-js is unusually decoupled — 17 of its 22 modules import nothing at all — so
its search can be adopted without its renderer, its book parser, or anything else.
`search.js` imports nothing; `text-walker.js` imports nothing. Together they are
~7KB and replace a hand-rolled scan that was slower, had no locale handling, and
crashed.

## Upgrading

Copy the two files from the pinned repository again and update the commit above.
They are used from src/reader/epub/adapter.ts through `searchMatcher(textWalker, …)`,
which yields `{ range, excerpt }` over a `Document`.
