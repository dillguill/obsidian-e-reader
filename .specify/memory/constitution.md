<!--
Sync Impact Report
Version change: 1.0.0 → 1.1.0
Bump rationale: MINOR. No principle was removed or redefined, and nothing compliant under 1.0.0
becomes non-compliant, so this is not a MAJOR change. It is more than a clarification: a binding
numeric limit is relaxed and two new binding obligations are added, which is materially expanded
guidance.

Modified principles:
- V. Reading Performance — unchanged in name and intent; gains an explicit rule that large
  dependencies load on first use rather than at plugin startup.

Modified sections:
- Platform & Compatibility Constraints — the flat 1 MB bundle limit is replaced by a two-tier limit
  that preserves the original discipline for authored code while permitting a vendored document
  rendering engine under stated conditions.

Added sections: none
Removed sections: none

Amendment driver: specs/001-bases-ereader requires the plugin to bundle a current PDF rendering
engine rather than build on the one embedded in Obsidian, which is materially behind upstream and
carries documented defects in text selection accuracy and right-to-left rendering. A bundled engine
is several megabytes and cannot fit the 1 MB cap. Principle II was deliberately NOT amended: the
chosen approach avoids patching or reading Obsidian's internals, so the prohibition stands intact.

Follow-up TODOs: none. No placeholders deferred.
-->

# Obsidian E-Reader Constitution

## Core Principles

### I. Vault Data Integrity (NON-NEGOTIABLE)

The user's vault is their data, not the plugin's working storage. All reads and writes MUST go
through the Obsidian `Vault` and `MetadataCache` APIs; direct filesystem access to vault paths is
prohibited. The plugin MUST NOT create, rename, move, or delete any note, attachment, or folder
except as the direct and visible result of a user action. Destructive operations MUST be reversible
through Obsidian's own undo/trash behavior — never a hard delete. Plugin-owned state (reading
positions, bookmarks, per-book settings) MUST live in plugin data (`loadData`/`saveData`) or a
clearly namespaced plugin folder, never smuggled into user note bodies without explicit opt-in.

*Rationale: A reader plugin has broad vault access and no natural reason to mutate content.
Corrupting or silently rewriting a user's notes is the single highest-severity failure mode
available to this project, and it is unrecoverable for users without backups.*

### II. Public API Fidelity

The plugin MUST build only against documented, public Obsidian APIs. Accessing undocumented
internals (`app.*` private members, unexported classes), patching Obsidian or third-party
prototypes, and mutating DOM owned by Obsidian or other plugins are all prohibited. Every listener,
interval, observer, ribbon icon, command, and view registration MUST be created through the
corresponding `register*` helper so that `onunload` leaves no residue: after disable, the plugin
MUST leave zero timers, zero listeners, and zero injected styles behind.

*Rationale: Monkeypatching is a workaround that masks a root-cause defect and breaks silently on
every Obsidian update. Clean unload is also a hard requirement for community plugin review.*

### III. Test-First (NON-NEGOTIABLE)

TDD is mandatory. For every feature and bugfix the order is: write the test → confirm it fails for
the intended reason → implement → confirm it passes. A bugfix MUST include a regression test that
reproduces the reported symptom and fails before the fix. Pure logic — parsing, pagination,
position mapping, settings migration — MUST be unit-testable without an Obsidian runtime, which
requires keeping that logic out of view and DOM classes. Merging code whose tests were written
after the implementation is a violation, not a shortcut.

*Rationale: Reader state (positions, progress, offsets) is easy to break invisibly and hard to
verify by hand. Tests written after the fact encode the bug rather than the requirement.*

### IV. Platform Parity

Features MUST work on Obsidian desktop and mobile alike. Node, Electron, and filesystem APIs are
prohibited in shared code paths; any desktop-only capability MUST be feature-detected at runtime and
degrade to a working, non-broken state on mobile rather than throwing. If a capability cannot be
supported on mobile at all, the plugin MUST declare `isDesktopOnly` in its manifest — declaring it
to avoid the work of parity is not permitted. Touch input, small viewports, and the mobile toolbar
MUST be treated as first-class targets in every UI change.

*Rationale: Reading is the use case most likely to happen on a phone or tablet. A reader that only
works on desktop fails its primary context of use.*

### V. Reading Performance

Reading MUST stay responsive on large documents. The main thread MUST NOT be blocked by parsing,
pagination, or search: work proportional to document size MUST be chunked, deferred, or moved off
the critical path. Documents MUST be rendered incrementally rather than materialized whole. The
following budgets are binding and MUST be measured, not assumed: plugin load adds under 100 ms to
Obsidian startup; opening a book renders its first page in under 1 second; page turns and scrolling
hold 60 fps. Any change that regresses a budget MUST be fixed or reverted before merge. Large
dependencies — document rendering engines above all — MUST be loaded on first use and MUST NOT be
loaded, parsed, or evaluated during plugin startup, so that the startup budget holds for a session
in which no book is opened.

*Rationale: Perceived jank in a reading surface is the defect users notice first and forgive least,
and startup cost is paid by every user on every launch whether they open a book or not.*

## Platform & Compatibility Constraints

- **Language and build**: TypeScript with `strict: true`. `any` and non-null assertions require an
  inline comment justifying them. The build bundles to a single `main.js` via the standard Obsidian
  plugin toolchain.
- **API baseline**: `minAppVersion` in `manifest.json` MUST name the lowest Obsidian version the
  plugin is actually tested against, and MUST be raised whenever a newer API is adopted.
- **Bundle size**: the plugin's own compiled code MUST stay under 1 MB. Vendored document rendering
  engines are exempt from that figure and are instead capped at 5 MB combined; the total shipped
  plugin MUST NOT exceed 6 MB. A vendored engine qualifies for the exemption only if it is loaded on
  first use rather than at startup, as Principle V requires. Every other runtime dependency remains
  subject to the 1 MB limit. All dependencies MUST be justified against writing the needed capability
  directly, and MUST carry a license compatible with redistribution.
- **Vendoring a rendering engine**: bundling an engine is permitted only where Obsidian provides no
  equivalent, or where the equivalent it provides is demonstrably defective for the plugin's purpose.
  The pull request introducing one MUST record which of those applies and what evidence supports it.
  Vendoring MUST NOT be used to avoid learning an Obsidian API that would otherwise serve.
- **Privacy**: no telemetry, analytics, or crash reporting. No network request may be issued except
  to a destination the user explicitly configured for that purpose. The plugin MUST function fully
  offline.
- **Release artifacts**: `manifest.json`, `versions.json`, and the release tag MUST agree on the
  version for every release.

## Development Workflow & Quality Gates

- **Spec-driven flow**: non-trivial work follows the Spec Kit sequence — specify, plan, tasks,
  implement. Feature work begins from a written spec, not from code.
- **Merge gates**: a change may merge only when the full test suite passes, type-checking and lint
  pass with zero errors, and the change has been exercised manually in a real vault on both a
  desktop and a mobile client when it touches UI or vault access.
- **Review**: every change is reviewed against these principles by name. A reviewer who cannot
  identify which principle a risky change satisfies MUST block it.
- **Complexity**: added abstraction MUST be justified in the pull request by the concrete problem it
  solves. Speculative generality is rejected by default.
- **Versioning**: the plugin follows semantic versioning. Breaking changes to stored plugin data
  require a migration that is tested against the prior schema.

## Governance

This constitution supersedes all other development practices for this project. Where a habit, a
tool default, or a convenience conflicts with a principle here, the principle wins.

**Amendment procedure**: amendments MUST be proposed as a written change to this file, stating the
principle affected, the rationale, and the migration required of existing code. An amendment takes
effect when merged, and the Sync Impact Report at the top of this file MUST be updated in the same
change.

**Versioning policy**: this constitution is versioned independently of the plugin. MAJOR for a
removal or backward-incompatible redefinition of a principle or governance rule; MINOR for a new
principle or a materially expanded section; PATCH for clarifications and wording that do not change
what is required.

**Compliance review**: every pull request verifies compliance with these principles. Violations
MUST be remediated at the root cause; suppressing a symptom with a workaround, a retry loop, or a
corrective background task is itself a violation. If a principle proves genuinely wrong, amend it
rather than route around it. Runtime development guidance for agents lives in `AGENTS.md`, which
MUST stay consistent with this document.

**Version**: 1.1.0 | **Ratified**: 2026-08-20 | **Last Amended**: 2026-08-20
