# Specification Quality Checklist: Bases-Backed E-Reader Library

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-20
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`

### Validation record

**Iteration 1** — one failure found and corrected:

- *Requirements are testable and unambiguous* initially failed on **FR-017**, which read "presentation
  controls appropriate to the format" — untestable, since nothing establishes what is appropriate. It
  was rewritten to name the minimum controls required per format. All other items passed on the first
  pass.

**Iteration 2** — all items pass.

**Iteration 3 (post-clarification, 2026-08-20)** — re-validated against the spec as updated by
`/speckit-clarify`. All 16 items still pass; no checkbox changed state.

- *No implementation details* passes but with a narrower margin than before. Clarification
  deliberately settled a storage shape, a protocol version, and a credential policy. The functional
  requirements stay behaviour-worded — FR-031a says "where the platform provides secret storage"
  rather than naming an API — and the platform-specific facts (the 1.11.4 version floor, the OPDS 2.0
  exclusion) are quarantined in Assumptions and Clarifications, which exist for exactly that.
- *Requirements are testable* strengthened: FR-015a-c, FR-028a-c, and FR-031a-d replace previously
  implicit behaviour with checkable statements.
- *Scope is clearly bounded* strengthened by naming OPDS 2.0 an explicit non-goal.

**Iteration 4 (second clarification session, 2026-08-20)** — re-validated after the reader-engine
decision. **15/16 items pass; one regression.**

- **REGRESSED — *No implementation details*.** FR-014a now directs that the plugin bundle a current
  PDF rendering engine rather than build on Obsidian's embedded viewer, and FR-014d constrains when
  that engine may load. These are architecture decisions sitting in functional requirements, so the
  item fails on its own terms. The regression is deliberate and the reasoning is recorded in the
  Clarifications log: the choice was forced by documented defects in Obsidian's bundled engine, and
  leaving it open would have made the requirements around selection accuracy and right-to-left
  support unsatisfiable. Planning should treat these as fixed constraints rather than re-derive them.
- All other items continue to pass. *Requirements are testable* strengthened again by FR-014a-d,
  FR-016a-c, and FR-020.

### Decisions resolved by clarification

The three open decisions previously carried into planning are now settled in the spec and are no
longer open:

1. **Annotation granularity** — resolved *against* the original recommendation. Highlights are
   blockquote entries in the book note with block references, following Annotator's arrangement, not
   one note per annotation. The book note is the aggregate record: metadata in frontmatter,
   highlights in the body. Highlights are browsed in the sidebar, so per-highlight Bases
   queryability was explicitly dropped as a requirement.
2. **Bookmark storage** — resolved. A bookmark is a typed entry of the same kind as a highlight,
   reusing its anchoring, block references, deletion, and unanchored preservation.
3. **Progress write cadence** — superseded by a stronger rule. Position now has two values, last-read
   and furthest-read, with furthest-read advancing only and never being applied without the reader
   accepting a prompt.

### Resolved dependency

The constitution's 1 MB bundle cap conflicted with bundling a PDF engine. **Resolved in constitution
v1.1.0** (2026-08-20): authored code stays under 1 MB, vendored rendering engines are capped at 5 MB
combined, total shipped plugin at 6 MB, and the exemption holds only for an engine loaded on first
use. Principle II was left unamended and remains binding. No governance obstacle to planning
remains.

### Remaining gaps (low impact, not blocking)

- **Accessibility** is addressed only for text direction and script rendering. No screen-reader or
  dynamic-type requirements exist. Worth revisiting, but no constitutional principle binds it.
- **Observability** is unspecified and is better settled during planning.
- **Catalog rate limiting** is unaddressed; relevant only for public catalogs under heavy use.
