# One repair engine and coarse network operations

`crates/engine` implements the shared library in Rust.
The backend links it natively, and parity tools can load its WebAssembly build through `src/engine/wasm.ts`.
Matching, speech normalization, history indexes, directory traversal, validation policy, help-tree discovery and learned metadata have one implementation.
The library's types live in `crates/engine/src/types.rs`, and it has no filesystem, subprocess, browser, network or terminal effects.
Historical TypeScript revisions remain available in Git for parity comparisons.

The default remains server execution: `npm start` or `npm run dev`.
Use `TERMAI_ENGINE=client npm start` (or `npm run dev`) to route requests through the browser coordinator.
Both production modes keep interpretation and dependent host facts on the backend, avoiding sequential browser fact exchanges.
The WebSocket hello message announces the choice to the frontend, without an additional request.

## Adapters

- `crates/server/src/engine.rs` supplies native host facts and delegates to the library's bounded asynchronous runtime.
  Native help, script and completion adapters retain probe-pool capacity and cancellation.
- `src/suggestion-worker.ts` sends one coarse repair request without fetching context keys or catalogs first.
- Each `Discovery` instance owns a session's learned metadata.
  Request-owned host futures keep cancellation and fact memoization isolated between overlapping repairs.
- Terminal edits and execution remain outside the library.
  Host adapters obtain facts; the engine decides how to interpret and rank them.

Native execution calls the filesystem and subprocess providers directly.
It does not serialize intermediate facts, start a browser repair worker or push periodic catalogs.
Prompt-time metadata prewarming is retained.
Native discovery uses routes already verified by the engine instead of rewalking every help ancestor as an HTTP boundary must.
File-operand validation requests metadata without an extra executable-access check, preserving master's original I/O behavior.

Managed SSH sessions honor the configured mode instead of forcing browser interpretation.
Both coordinators obtain lightweight context on the backend and fetch targeted facts during repair.
Periodic catalog and directory pushes are removed, and prompt-time prewarming is shared between coordinators.
Herdr retains an engine and help provider per terminal context and invalidates them when the shell or environment changes.

## Validation and performance

The Rust migration benchmark compares the retained TypeScript implementation with native Rust and Wasm using the same working-tree snapshot and prepared inputs.
It checks complete candidate arrays and rejects increases in cold or warm foreground request counts for any case.

Run `BENCH_SUITE=shared BENCH_BEFORE_MASTER=. BENCH_BEFORE_CLIENT=. BENCH_AFTER=. BENCH_RUST=1 BENCH_REPEATS=3 npm run bench:architecture`.
By default, the after variants use a copied snapshot of the working tree; set `BENCH_AFTER` to a commit for a reproducible revision.
`BENCH_RTT`, `BENCH_REPEATS`, `BENCH_COLD_REPEATS` and `BENCH_OUTPUT` control the measurement.
Cold latency uses the median of fresh application-cache trials and retains the first call and individual cold samples separately.
The original four-way architecture benchmark remains available without `BENCH_SUITE`.

Run `npm test`, `npm run test:rust` and `npm run build`, then `TEST_ENGINE=server npm run test:browser` and `TEST_ENGINE=client npm run test:browser`.
`TEST_BASE_PATH=/t` checks a mounted deployment.
Server browser checks reject worker creation, fact requests and context pushes.
Client browser checks require one coarse repair request without prerequisite context keys.

See the [Rust migration report](rust-migration.md) for current parity results, browser initialization measurements and platform gates.
The [workspace implementation](workspace.md) supplies SSH and multiple backends through adapters to this engine.

## Historical TypeScript consolidation results (`516ad8f`)

Both execution modes retain the pre-change request counts and candidate arrays across all nine cases.
The recorded runs passed **8,208 candidate-array comparisons**: seven warm repetitions at each of 0/50/150 ms RTT, plus two local runs of 101 warm repetitions in opposite variant orders.
The build, all **72 unit tests**, and browser/transport suites in server mode at `/` and client mode at `/t` passed.

Warm medians at **150 ms simulated RTT**, milliseconds:

| Case | Master before | Shared native | Experiment before | Shared browser |
| --- | ---: | ---: | ---: | ---: |
| History match | 151.00 | 151.15 | 151.77 | 151.87 |
| Known command/schema | 151.43 | 151.48 | 152.21 | 152.06 |
| Compact flags | 151.34 | 151.43 | 151.91 | 151.89 |
| Python arguments | 154.24 | 154.17 | 456.35 | 456.18 |
| Nested help | 151.44 | 151.19 | 151.80 | 151.70 |
| Fuzzy directory | 151.66 | 151.78 | 151.13 | 151.11 |
| Exact directory | 151.18 | 151.04 | 150.94 | 151.29 |
| Large directory | 151.68 | 151.55 | 151.22 | 151.19 |
| Referenced filename | 158.75 | 159.03 | 763.43 | 762.95 |

Warm local medians with **no injected RTT**, pooling the two opposite-order runs (202 samples per cell), milliseconds:

| Case | Master before | Shared native | Experiment before | Shared browser |
| --- | ---: | ---: | ---: | ---: |
| History match | 0.32 | 0.36 | 0.92 | 0.88 |
| Known command/schema | 0.81 | 0.82 | 1.21 | 1.27 |
| Compact flags | 0.71 | 0.72 | 1.15 | 1.17 |
| Python arguments | 3.26 | 3.20 | 3.97 | 3.95 |
| Nested help | 0.65 | 0.64 | 1.23 | 0.92 |
| Fuzzy directory | 0.30 | 0.30 | 0.29 | 0.29 |
| Exact directory | 0.20 | 0.20 | 0.23 | 0.23 |
| Large directory | 0.30 | 0.29 | 0.39 | 0.38 |
| Referenced filename | 8.13 | 8.04 | 8.77 | 8.84 |

The largest increase in pooled local warm medians was 0.07 ms.
At 150 ms RTT, the largest warm increase was 0.35 ms; at 50 ms RTT it was 1.33 ms.
These small differences, and the changes in the opposite direction, do not show a material latency regression.
They do not prove literal zero overhead or a speedup.
Foreground request counts are checked automatically and did not increase in either cold or warm runs.
Warm foreground byte counts also stayed unchanged.

Cold results remain similar: at 150 ms RTT, browser fuzzy-directory repair was 608.36 → 609.84 ms, exact-directory repair 458.84 → 457.51 ms, and nested help 775.43 → 776.30 ms.
Cold measurements are single samples per case/RTT; local cold timings fluctuate with JIT, filesystem and subprocess startup.
This refactor does not remove the existing cold-path and Python/filename network penalties.

[Raw results](shared-engine-results.json) include every case at every RTT, cold/warm timings, individual warm samples, foreground request/byte counts and idle-push costs.
Reproduce the latency run with `BENCH_SUITE=shared BENCH_AFTER=516ad8f BENCH_REPEATS=7 npm run bench:architecture`; for local runs use `BENCH_RTT=0 BENCH_REPEATS=101`, once normally and once with `BENCH_REVERSE=1`.

As in the earlier benchmark, client CPU runs in Node, native engines receive a prepared catalog, and warm browser trials model an already delivered idle context push.
Measurements exclude bandwidth throttling, HTTP/TLS overhead, worker startup, rendering and Readline replacement acknowledgements.
Browser suites verify behavior and mode isolation, not production phone latency.
