# Phase 0 Research: Bases-Backed E-Reader Library

**Feature**: [spec.md](./spec.md) | **Date**: 2026-08-20 | **Constitution**: v1.1.0

## R1 — Custom Bases view registration

**Decision**: Register the library view with `this.registerBasesView()` in `onload()`.

**Findings** — read directly from the `obsidian` 1.13.1 typings, which corrected two errors in the
third-party documentation consulted first:

```ts
registerBasesView(viewId: string, registration: BasesViewRegistration): boolean
type BasesViewFactory = (controller: QueryController, containerEl: HTMLElement) => BasesView
```

The method takes **two** arguments, not three, and returns a boolean that must be checked. The
factory receives a `QueryController` as well as the container.

```ts
abstract class BasesView extends Component {
  abstract type: string;
  app: App; config: BasesViewConfig; allProperties: BasesPropertyId[]; data: BasesQueryResult;
  abstract onDataUpdated(): void;
}
```

`onDataUpdated()` takes **no argument** — the view reads `this.data`. There is no `entries` property;
`BasesQueryResult` exposes `data: BasesEntry[]`, `groupedData: BasesEntryGroup[]`, and
`properties: BasesPropertyId[]`. The typings state that views "should support groupBy by using
`groupedData`", which added FR-007a to the specification.

`BasesEntry` carries `file: TFile` and `getValue(propertyId): Value | null`, with errors surfaced as
`ErrorValue` rather than thrown.

`BasesViewConfig` supplies `get`, `getAsPropertyId`, `getEvaluatedFormula`, `set`, `getOrder`,
`getSort`, and `getDisplayName`.

**Correction of record**: a secondary source gave the three-argument signature and an
`onDataUpdated(result)` parameter. Both are wrong. The typings are the authority.

**Rationale**: This is a documented public API, so FR-001 and FR-002 are satisfied without violating
Principle II. Filtering, sorting, searching, and property selection are handled by Bases itself —
the view receives already-filtered entries — which is precisely the "don't reinvent" outcome the
spec asks for. Progress and read state are read through `getValue()`, so FR-005's
reader-selectable progress property maps onto `getAsPropertyId()`.

**Alternatives considered**: A standalone `ItemView` with a custom query language — rejected, it
would rebuild filtering and sorting that Bases already provides and would not persist in `.base`
files. Rendering into the built-in table view — rejected, no extension point.

**Minimum version — resolved.** Every Bases symbol above is annotated `@since 1.10.0` in the typings,
matching the release notes: Bases arrived as a core plugin in 1.9.0 and its API in 1.10.0.
`minAppVersion` is **1.10.0**. `app.secretStorage` and the `SecretStorage` class are `@since 1.11.4`
(R6) and are feature-detected rather than raising the floor. Still test against 1.10.0 rather than
only compiling against it — the constitution requires the lowest version actually tested.

## R2 — EPUB rendering engine

**Decision**: Vendor **foliate-js**, pinned to a specific commit.

**Findings**: MIT licensed, with vendored dependencies under BSD-3-Clause, MIT, and Apache — all
redistributable, satisfying the constitution's licence constraint. Pure JavaScript with no hard
dependencies. Modular ES modules split into parsers (`epub.js`, `mobi.js`, `fb2.js`,
`comic-book.js`), renderers (`paginator.js`, `fixed-layout.js`), and auxiliary modules
(`overlayer.js`, `progress.js`, `search.js`).

Directly relevant modules: `overlayer.js` provides highlight rendering, answering FR-016b;
`search.js` covers in-book search for FR-016; `progress.js` supports FR-015; CFI support gives a
precise location hint for FR-020; table-of-contents navigation covers FR-025. It also ships an
**OPDS client**, which is relevant to R5.

Precedent in the ecosystem: Weave Reader is built on foliate-js, and Local Book Reader bundles it
with a patch removing `allow-scripts` from its iframe for the Electron environment.

**Rationale**: It covers rendering, anchoring, search, TOC, highlight overlay, and progress in one
dependency-free package, which is materially less to build and maintain than assembling equivalents.

**Risk**: The authors state plainly that the library "is _not_ stable. Expect it to break and the
API to change at any time." Mitigation: vendor a pinned copy rather than tracking a moving
dependency, and keep plugin code behind a narrow internal reader interface so an engine swap does
not reach the rest of the codebase.

**Alternatives considered**: epub.js — used by the EPUB Reader and Highlighter plugin, more widely
known, but larger, less modular, and with weaker character-level offset handling. Writing a renderer
from scratch — rejected outright against the project's stated philosophy.

## R3 — PDF rendering engine and bundle budget

**Decision**: Vendor **pdfjs-dist**, loaded lazily on first PDF open.

**Findings** (measured from the published package):

| File | Size | Needed |
|---|---|---|
| `pdf.min.mjs` | 394 kB | Yes — display layer |
| `pdf.worker.min.mjs` | 1.04 MB | Yes — core parsing worker |
| `*.mjs.map` | ~7 MB total | No — source maps, excluded |
| `cmaps/` | ~1–2 MB | Only for CJK documents |
| `standard_fonts/` | ~0.5–1 MB | Only where fonts are not embedded |

Core runtime is therefore **≈1.44 MB**, rising to roughly 3.5 MB if cmaps and standard fonts are
shipped for full document coverage.

**Rationale**: Comfortably inside the constitution's 5 MB engine allowance (v1.1.0). Note for the
record: the widely quoted ~3.94 MB figure is the entire npm package including source maps, not the
shipping weight. The original 1 MB cap was nonetheless unachievable, since the worker alone exceeds
it — the amendment was necessary, but the headroom is generous rather than tight.

**Decision on optional assets**: Ship core only in the first release; treat cmaps and standard fonts
as a follow-up once real documents demonstrate the need. This keeps the initial footprint near
1.5 MB.

**Alternatives considered**: Obsidian's embedded pdf.js — rejected during clarification; it is
materially behind upstream with documented defects in text selection accuracy and RTL rendering, and
reaching it requires internals access that Principle II forbids.

## R4 — Highlight anchoring

**Decision**: Quoted text plus surrounding context is the authoritative anchor for both formats, per
FR-020. A format-specific location hint is stored alongside it: an EPUB CFI from foliate-js, and a
page number for PDF.

**Rationale**: Text-quote anchoring degrades gracefully when a file is edited or replaced with
another edition, which is what FR-024's unanchored-but-preserved behaviour requires. A CFI or page
number alone breaks hard in that case. Storing the hint as well makes the common path fast — jump
directly, verify the quote matches — and falls back to a search only when the hint misses.

**Approach**: Prefix/exact/suffix selector, the same shape hypothes.is uses and that Annotator
inherits. Resolution order: try the hint, confirm the quote; on mismatch, search the document for
the exact quote disambiguated by prefix and suffix; on failure, mark unanchored.

**Context window — resolved**: 32 characters of prefix and suffix, configurable. Long enough to
disambiguate a repeated phrase in ordinary prose, short enough that an edit near the quote does not
invalidate the anchor (CHK011).

## R8 — View configuration uses Bases option primitives

**Decision**: Declare every library view setting through `BasesViewRegistration.options`, using the
primitives Bases already provides. The plugin draws no settings UI for view configuration.

**Findings**: `BasesAllOptions` covers dropdown, file, folder, formula, multitext, property, slider,
text, and toggle, plus `BasesOptionGroup` for grouping. Each carries `key`, `type`, `displayName`,
and an optional `shouldHide()`. `BasesSliderOption` supports `min`, `max`, `step`, `default`, and
`instant`; `BasesPropertyOption` supports a `filter` that narrows the property picker.

**Mapping**: `coverProperty`, `progressProperty`, `readStateProperty` as property options;
`progressDisplay` as a dropdown; `tileSize` as a slider (80–240, step 10, default 140, instant).

**Rationale**: Settings render in the Bases toolbar and persist in the `.base` file exactly like a
built-in view's, which is what "feel as native as possible" means concretely. It also removes an
entire settings surface from the build.

## R5 — OPDS 1.2 catalog client

**Decision**: Parse OPDS 1.2 Atom feeds with the platform `DOMParser`, evaluating foliate-js's
bundled OPDS client first as a possible substitute.

**Rationale**: OPDS 1.2 is Atom XML; `DOMParser` is available on desktop and mobile and adds nothing
to the bundle. No XML library is warranted. foliate-js already includes an OPDS client, so the first
implementation task is to assess whether it covers navigation feeds, search, paging, and
authentication before writing one.

**Constraint**: Requests must use Obsidian's `requestUrl` rather than `fetch`, since `requestUrl`
bypasses CORS and works identically on desktop and mobile — required by FR-038 and Principle IV.

**Alternatives considered**: OPDS 2.0 JSON — explicitly out of scope per clarification.

## R6 — Credential storage

**Decision**: Obsidian `SecretStorage` where available; an in-memory, session-only prompt otherwise.

**Findings**: `SecretStorage` exists since Obsidian **1.11.4** with `getSecret(id)`, `setSecret(id, secret)`,
and `listSecrets()`. It does not synchronise across devices and is not available on mobile. Its
initial implementation stored values unencrypted in Local Storage, with the maintainer committing to
migrate to Electron `safeStorage`.

**Rationale**: Satisfies FR-031a without writing credentials into the vault. FR-031b's prohibition on
home-grown encryption is respected. Because the API is version-gated and platform-limited, detection
must be at runtime with the session-prompt path as a first-class experience, not an error path.

## R7 — Testing and build

**Decision**: Vitest for unit tests over pure logic; a thin fake of the Obsidian module for anything
touching the API; esbuild for bundling with the engines as lazily-imported chunks.

**Rationale**: Principle III requires parsing, anchoring, position mapping, and settings migration to
be testable without an Obsidian runtime, which forces that logic out of view classes. Principle V and
FR-014d require the engines to sit behind dynamic `import()` so they are neither parsed nor evaluated
at startup.

**Open**: Whether Obsidian's own test conventions or a community harness should be preferred is
unresolved and does not block Phase 1.

## Spec amendments made during planning

Research surfaced two contradictions and several undefined behaviours. All have been resolved in the
specification rather than carried into implementation.

1. **CHK017 — contradiction, resolved.** FR-037 now covers file lifecycle and note bodies; FR-037a
   exempts reading state in the open book's frontmatter under debounce; FR-037b forbids all other
   automatic writes. SC-009 restated as a measurable idle observation.
2. **CHK001 — format, resolved.** `contracts/highlight-entry.md` fixes the entry form. Block
   identifiers for structured blocks sit on their own line after a blank line, per Obsidian's linking
   documentation — the earlier draft had this wrong. Entry discovery uses `CachedMetadata.blocks` and
   `sections` rather than a hand-written parser.
3. **CHK011 — context window, resolved.** 32 characters each side, configurable.
4. **UI decisions, resolved.** FR-007 (open target and modifiers), FR-007a (groupBy), FR-008a–f
   (aspect ratio, native slider sizing, native option primitives, non-colour read state, empty
   states, progressive loading).
