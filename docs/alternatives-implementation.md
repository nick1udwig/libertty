# Alternatives implementation queue

Implement the [review proposals](alternatives-pipeline-review.md) in separate commits, with regression checks and fixes before each commit.
Retain the shared Rust engine, original transcript choices, non-executing validation, and authoritative edit guards.

- [x] Preserve script option scope and interpreter invocation boundaries.
  Native engine and catalog tests pass, including multiple script options, interpreter options, and module exclusion.
  Canonical vocabulary contract checks pass.
- [x] Retain candidates through validation and combine history with relevant alternatives.
  Engine and native regression suites pass, including stale catalog refill and history ambiguity.
- [x] Batch independent facts and reduce redundant filesystem and completion work.
  A runtime regression verifies that three independent operands require one callback wave.
  Engine, native, filesystem, and completion suites pass, including broader completion fallback after unrelated narrow matches.
- [x] Use coarse backend repair for network-dependent work and retain Herdr metadata.
  Both production coordinators obtain context on the backend in one repair request, with no periodic catalog pushes.
  SSH placement, HTTP prompt guards, Herdr context isolation, native integrations, the frontend build, and browser regressions in both modes pass.
- [x] Compose repair over shared shell structure, preserving opaque quoted syntax and supporting command lists and wrappers.
  Engine, native, fact-boundary, schema-contract, and TypeScript checks pass for shared operators, nested help, wrappers, opaque expressions, and directory-dependent commands.
- [x] Share path traversal and schema evidence across commands and option values.
  Shared traversal covers input commands and schema-declared path values, including misspelled intermediate directories.
  Option schemas carry cardinality, choices, and path roles, and Python inspection excludes child-parser options from the root schema.
  Engine, native, filesystem, schema-contract, and TypeScript checks pass.
- [x] Separate typed candidate changes, discovery completeness, cache invalidation, budgets, and partial results.
  Typed changes preserve existing wire explanations, while ranking uses normalized match evidence and unresolved operands.
  Learned schemas retain completeness and executable versions, and independent failures leave validated alternatives available.
  Engine, native, completion, fact-contract, and TypeScript checks pass, including executable replacement and slow-probe deadline regressions.
- [ ] Combine repair and guarded line application, including backend dictation.
- [ ] Verify end-to-end behavior and network request budgets, then evaluate whether additional SSH infrastructure is warranted.
- [ ] Keep the old screen visible with a loading bar when returning to the app, and replace it only when the new screen is ready.

Update this queue with validation evidence as each change is committed.
