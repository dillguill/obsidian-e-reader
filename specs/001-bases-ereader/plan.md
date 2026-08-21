# Implementation Plan: Bases-Backed E-Reader Library

**Branch**: `001-bases-ereader` (feature directory; the working git branch is `main`) | **Date**: 2026-08-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-bases-ereader/spec.md`

## Summary

An Obsidian plugin that turns notes marked `type: book` into a reading library and reads the books
themselves without leaving the vault. The library is a **custom Bases view** registered through the
public `registerBasesView()` API, so filtering, sorting, searching, and property selection stay with
Bases while the view contributes cover tiles, read-state overlays, and progress display. Books are
markdown notes whose frontmatter holds metadata and whose body holds highlight entries; the book file
is an untouched attachment.

The plugin renders **both** formats itself, vendoring foliate-js for EPUB and pdfjs-dist for PDF,
loaded lazily on first use. This was decided after establishing that Obsidian's embedded PDF engine
is materially behind upstream with documented text-selection and RTL defects, and that reaching into
it would require the internals access Principle II forbids. Constitution v1.1.0 amended the bundle
cap to permit this; Principle II was deliberately left intact.

Highlights and bookmarks are one entry kind, anchored by quoted text with a format-specific location
hint, so both survive the file being edited or replaced.

## Technical Context

**Language/Version**: TypeScript 5.x, `strict: true`, ES2022 modules

**Primary Dependencies**: `obsidian` (API types); vendored **foliate-js** (MIT, pinned commit) for
EPUB; vendored **pdfjs-dist** (Apache-2.0) for PDF. No other runtime dependencies.

**Storage**: Vault content only. Frontmatter for book metadata and reading state; note body for
highlight entries; plugin data for settings; `SecretStorage` or session memory for credentials. No
private database.

**Testing**: Vitest for pure logic — anchoring, locators, entry parsing, frontmatter, settings
migration — against a thin fake of the `obsidian` module. Manual validation per
[quickstart.md](./quickstart.md) on desktop and mobile.

**Target Platform**: Obsidian desktop (Windows/macOS/Linux) and mobile (iOS/Android).
`minAppVersion` **1.10.0**, confirmed from the `obsidian` 1.13.1 typings where every Bases symbol is
annotated `@since 1.10.0`. `app.secretStorage` is `@since 1.11.4` and is feature-detected above the
floor rather than raising it. Test against 1.10.0, not merely compile against it.

**Project Type**: Obsidian community plugin — single project, single `main.js` artifact.

**Performance Goals**: Plugin load adds <100 ms to Obsidian startup with no engine parsed; first page
within 1 s of opening a book; 60 fps page turns and scrolling; 500-book library first screen within
2 s.

**Constraints**: Offline except catalog operations; no telemetry; no writes to book files; clean
unload with zero residue; authored code <1 MB, engines <5 MB, total <6 MB.

**Scale/Scope**: 6 user stories, 62 functional requirements, 12 success criteria. Two rendering
engines, one Bases view, three sidebar tabs, one catalog client.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1.*

| Principle | Gate | Pre-Phase 0 | Post-Phase 1 |
|---|---|---|---|
| I. Vault Data Integrity | Vault API only; no writes without reader action; book files never rewritten | PASS | PASS — `data-model.md` confines writes to frontmatter and a delimited body region; `FR-010` holds |
| II. Public API Fidelity | Documented APIs only; no prototype patching; clean unload | PASS | **PASS — strengthened.** `registerBasesView` is public (R1); the PDF decision explicitly avoids Obsidian's internals; `FR-014c` avoids needing the internal `viewRegistry.unregisterExtensions`; `destroy()` is contractual |
| III. Test-First | Failing test first; logic testable without Obsidian | PASS | PASS — anchoring, locators, and entry parsing are pure modules by construction |
| IV. Platform Parity | Mobile first-class; no Node/Electron APIs | PASS | PASS — `requestUrl` over `fetch`; both engines are browser-targeted |
| V. Reading Performance | Four numeric budgets; large deps load on first use | PASS | PASS — `FR-014d` and the engine contract require dynamic `import()` |
| Bundle size (v1.1.0) | Authored <1 MB; engines <5 MB; total <6 MB | PASS | PASS — measured ≈1.44 MB for pdfjs core plus foliate-js; well inside the allowance |
| Vendoring justification (v1.1.0) | Engine permitted only where Obsidian offers none or its equivalent is demonstrably defective | PASS | PASS — see Complexity Tracking |
| Privacy | No telemetry; no unconfigured network calls | PASS | PASS — `FR-039`, `FR-031a-c` |

**No unjustified violations. No gate blocks Phase 2.**

## Project Structure

### Documentation (this feature)

```text
specs/001-bases-ereader/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── bases-view.md
│   ├── highlight-entry.md
│   ├── reader-engine.md
│   └── opds-client.md
├── checklists/
│   ├── requirements.md
│   ├── data-integrity.md
│   └── ui.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── main.ts                     # Plugin entry: registrations only, no heavy work
├── core/
│   ├── locator.ts              # Locator parse/serialise, per format
│   ├── anchor.ts               # Text-quote resolution (pure, heavily tested)
│   ├── frontmatter.ts          # Book note read/write, namespaced and non-clobbering
│   └── types.ts
├── library/
│   ├── library-view.ts         # BasesView subclass — onDataUpdated
│   └── tile.ts                 # Cover, read-state overlay, progress
├── reader/
│   ├── engine.ts               # ReaderEngine / BookHandle interfaces
│   ├── reader-view.ts          # Obsidian ItemView hosting an engine
│   ├── epub/adapter.ts         # foliate-js — the ONLY importer of it
│   └── pdf/adapter.ts          # pdfjs-dist — the ONLY importer of it
├── annotations/
│   ├── entry.ts                # Parse/serialise the body region
│   ├── store.ts                # Two-way sync with the book note
│   └── promote.ts              # FR-022b
├── sidebar/
│   ├── highlights-view.ts
│   ├── outline-view.ts
│   └── bookmarks-view.ts
├── catalog/
│   ├── opds.ts                 # OPDS 1.2 Atom parsing
│   ├── search-modal.ts
│   └── download.ts             # Atomic: temp file → note → move
└── settings/
    ├── settings-tab.ts
    └── credentials.ts          # SecretStorage with session fallback

vendor/                         # Pinned engine sources, lazily imported
tests/
├── unit/                       # Pure logic — no Obsidian runtime
└── fakes/obsidian.ts
```

**Structure Decision**: Single project. An Obsidian plugin ships one `main.js`, so a multi-package
split would add build complexity without a consumer. The directory boundaries above exist to serve
Principle III: `core/` and `annotations/entry.ts` hold the logic that must be unit-testable without
Obsidian, and are deliberately free of view code. `vendor/` is isolated so the two adapter files are
the only code aware of either engine — the mitigation for foliate-js's unstable API.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Vendoring a PDF engine (~1.44 MB) rather than using Obsidian's | Constitution v1.1.0 permits vendoring where Obsidian's equivalent is "demonstrably defective for the plugin's purpose". Evidence: Obsidian's bundled pdf.js is materially behind upstream with documented "extremely inaccurate text selection and poor Arabic (RTL) support", and a maintainer response of "we will eventually update" with no timeline | Using Obsidian's viewer would inherit defects that FR-016a and the RTL edge case forbid. Patching it, as PDF++ does with `monkey-around`, requires undocumented internals prohibited by Principle II and breaks on Obsidian updates |
| Two rendering engines rather than one | Obsidian ships no EPUB viewer at all, and no single engine covers both formats well. foliate-js's PDF support is marked experimental | A single engine would degrade one format to satisfy symmetry |

## Blocking items — all resolved

| Item | Resolution |
|---|---|
| `minAppVersion` | **1.10.0**, confirmed from typings (`@since 1.10.0` on every Bases symbol) |
| CHK017 — FR-037 contradiction | Amended: FR-037 covers files and note bodies, FR-037a exempts debounced reading-state writes, FR-037b forbids all other automatic writes, SC-009 restated |
| CHK001 — entry format | Fixed in `contracts/highlight-entry.md`; block-id placement corrected against Obsidian's linking docs; discovery via `CachedMetadata.blocks`/`sections` |
| CHK011 — context window | 32 characters each side, configurable |
| UI CHK001–CHK008 | FR-007, FR-007a, FR-008a–f — open target with modifiers, groupBy, 2:3 covers, native slider sizing, native option primitives, non-colour read state, empty states, progressive loading |

### Carried into implementation, not blocking

- Whether `%%…%%` inside a callout is hidden in both reading and live-preview modes; a fallback form
  is specified if not.
- Whether foliate-js's bundled OPDS client covers the catalog contract, assessed before any parser is
  written.

### Corrections made while verifying

Two facts asserted earlier from secondary sources were wrong and are corrected in the artifacts.
`registerBasesView` takes **two** arguments and returns `boolean`, not three arguments;
`onDataUpdated()` takes **no** parameter and the view reads `this.data`. Block identifiers on
structured blocks require a blank line before them. The typings and official documentation are the
authority here, not third-party wikis.
