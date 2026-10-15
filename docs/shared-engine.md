# Native repair engine and coarse network operations

`crates/engine` implements the repair library in Rust, linked natively by the backend.
Matching, speech normalization, history indexes, directory traversal, validation policy, help-tree discovery and learned metadata have one implementation.
The library has no filesystem, subprocess, browser, network or terminal effects.
The frontend consumes its TypeScript types and sends repair transactions over the existing terminal WebSocket.
Historical TypeScript revisions remain in Git for benchmark comparisons.

## Execution and adapters

All repairs execute beside local or SSH host facts on the backend.
The retired `TERMAI_ENGINE` setting is ignored, and the hello message always announces `server`.
The former browser worker, Wasm bridge, `/api/context` and `/api/facts` endpoints have been removed.
Tools can request suggestions through `/api/suggest`.

`crates/server/src/engine.rs` supplies native host facts and delegates to the library's bounded asynchronous runtime.
Native help, script and completion adapters retain probe-pool capacity and cancellation.
`src/terminal.ts` sends one `repair` message and receives the applied line and alternatives in `repair-result`.
Cancellation, attachment, prompt and revision guards protect concurrent edits.
`crates/server/src/input_coordinator.rs` shares repair deadlines, cancellation and microphone callbacks across native terminals and Herdr.
The adapters retain attachment, shell and screen checks when applying text.
Rust terminal replies use the `ServerMessage` enum and are checked against the shared wire schemas.
HTTP requests and normalized Herdr snapshots use typed structures, while unknown saved notification-device fields are preserved.
Herdr metadata viewers and notification watches share one subscription per socket and SSH transport, with cached snapshots available to routes while listeners are active.
Herdr v0.9.3 closes ordinary RPC connections after one response, so connection reduction comes from sharing subscriptions and reusing cached snapshots.
Mutations invalidate cached metadata, and failed actions are never replayed.
Terminal input and terminal-specific mutations validate the live pane identity before applying text or changing a terminal.
Actions choosing a current directory or confirming a checkout refresh metadata before using those values.
Backend microphone dictation repairs its transcript locally and publishes alternatives.
Herdr additionally checks ownership, foreground shell identity and the last dictated span before replacement.

Each engine owns its learned metadata, while request-owned host futures isolate cancellation and fact memoization.
Prompt-time metadata prewarming remains shared by local and SSH sessions.
Herdr retains an engine and help provider per terminal context and invalidates them when the shell or environment changes.
Terminal edits and execution remain outside the engine library.

## Validation and performance

Run `npm run verify:local` for native Rust, JavaScript, installer, saved-data and browser coverage.
The browser suite runs each application harness once, including mounted-path checks.
Run `BENCH_SUITE=shared npm run bench:architecture` for native engine comparisons with historical TypeScript implementations.
The benchmark retains candidate correctness, cold and warm latency, request-count budgets and reversed-order confirmation.
Its adapter uses the native `engine_host` example without emulating the retired fact protocol.
`BENCH_RTT`, `BENCH_REPEATS`, `BENCH_COLD_REPEATS` and `BENCH_OUTPUT` control measurement.
Prepared-input timings exclude terminal application and real SSH traffic.

Run `node test/repair-network.mjs` for terminal transactions at injected 0/80/200 ms RTT.
Known-buffer repair uses one request; an unknown browser-tracked line requires a guarded Readline snapshot first.
The backend microphone obtains that snapshot directly through shell markers.
SSH filesystem traversal, listing freshness, verified help ancestors and completion planning remain backend dependencies.

See the [CI checks](ci.md), [workspace implementation](workspace.md) and historical [Rust migration report](rust-migration.md).
The results below describe the earlier TypeScript consolidation and its retired client coordinator.

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

[Raw results](../archive/migration/README.md) include every case at every RTT, cold/warm timings, individual warm samples, foreground request/byte counts and idle-push costs.
Reproduce the latency run with `BENCH_SUITE=shared BENCH_AFTER=516ad8f BENCH_REPEATS=7 npm run bench:architecture`; for local runs use `BENCH_RTT=0 BENCH_REPEATS=101`, once normally and once with `BENCH_REVERSE=1`.

As in the earlier benchmark, client CPU runs in Node, native engines receive a prepared catalog, and warm browser trials model an already delivered idle context push.
Measurements exclude bandwidth throttling, HTTP/TLS overhead, worker startup, rendering and Readline replacement acknowledgements.
Browser suites verify behavior and mode isolation, not production phone latency.
