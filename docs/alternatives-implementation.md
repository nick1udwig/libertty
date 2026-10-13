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
- [x] Combine repair and guarded line application, including backend dictation.
  One terminal request returns the applied line and alternatives under cancellation, attachment, prompt, and revision guards.
  Backend microphone and Herdr dictation reuse the transaction without a browser relay, and explicit reading intent preserves reader actions.
  Rust, frontend, native and mounted client browser, microphone, Herdr, contract, and lint checks pass.
- [x] Verify end-to-end behavior and network request budgets, then evaluate whether additional SSH infrastructure is warranted.
  Real terminal transaction checks use one request per known-buffer repair at injected 0/80/200 ms RTT in both coordinators.
  The architecture harness now models both current coordinators on the backend, builds its host before measuring, and passes shared-cohort checks.
  Full Rust and 99 frontend tests pass, and the network analysis records the remaining unknown-buffer snapshot and SSH dependencies.
  Retain the SFTP fallback and defer a remote worker until actual WAN tracing demonstrates a benefit that warrants its installation and lifecycle costs.
- [x] Keep the old screen visible with a loading bar when returning to the app, and replace it only when the new screen is ready.
  A painted viewport snapshot covers reconnect replay and Herdr redraw, and a loading bar remains visible until the new frame is painted.
  Normal terminals use the hello replay watermark, while Herdr retains its geometry and presentation acknowledgements.
  Workspace views retain their displayed-tab reference across hidden states, and pending views cannot receive stale input or shortcuts.
  Frontend, reconnect pixel retention, Herdr loading and native flash, workspace and SSH, schema-contract, Rust, and lint checks pass.

Update this queue with validation evidence as each change is committed.
