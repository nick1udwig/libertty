# Initial client-driven terminal experiment (`17e629b`)

This is a historical architecture report.
The client coordinator, browser Wasm adapter and separate context/fact protocol have since been retired; see [shared-engine.md](shared-engine.md) for current behavior.


The [follow-up directory optimizations](directory-optimizations.md) restore warm directory-repair latency to approximately master’s level.
This document preserves the original experiment and its measurements; use the follow-up for current behavior and results.

Branch: `experiment/client-driven-terminal`.
Baseline: `ba21e2c`.

The repair engine can run in the browser without losing the tested command interpretations or terminal behavior.
This implementation does **not** achieve equivalent latency for all workloads: fine-grained host requests amplify network latency.
Warm history/schema repairs are competitive; directory traversal, Python inspection and cold discovery regress.
This is a working architectural experiment, not a performance-neutral replacement ready to merge.

## Implemented boundary

| Responsibility | Location on this branch |
| --- | --- |
| Speech normalization, tokenization, fuzzy matching, ranking, history indexes | Browser worker, `src/engine/` |
| Command/flag schemas, validation policy, required operands, candidate selection | Browser worker |
| Directory traversal decisions, path correction and quoting | Browser worker |
| Discovery target selection, fuzzy subcommand-tree search, metadata cache | Browser worker |
| Terminal rendering, IME, alternatives, shortcuts | Browser main thread, as before |
| Filesystem facts, executable resolution, Bash syntax parsing, Python AST inspection | Host |
| Executing bounded help probes and independently authorizing help routes | Host |
| Catalog/history collection, shell integration, authoritative edit guards | Host |
| Authentication, PTY lifecycle, replay, acknowledgements, backpressure | Host, as before |

`/api/suggest` is removed.
`SuggestionClient` runs the portable engine in a dedicated worker, away from terminal rendering and keyboard handling.
`POST /api/facts` provides context plus bounded batches of `stat`, `entries`, `syntax`, `help` and `describe` operations.
These operations expose facts, not ranked suggestions or arbitrary background execution.
The native adapter and JSON adapter exercise the same engine.

The host verifies each help route against parent help (or an existing static schema) before invoking it.
Git shell aliases remain excluded.
Python inspection still parses an AST without importing the script.
These checks remain authoritative because a browser's claimed validation cannot be trusted by the host.
Existing authentication, same-origin checks, payload limits and the global two-process probe pool still apply.

The context carries cwd, command names, paths, history, home and an opaque environment fingerprint; it does not send environment values.
The complete catalog reaches browser memory, unlike the old suggestion endpoint, which normally returned only candidates.
Nothing new is persisted in local storage or the service worker cache.
Conditional catalog responses preserve immutable arrays and their matching indexes.
Catalog freshness is separate from shell identity: a help probe creating a file must not invalidate its own repair.
Prompt or environment changes invalidate subsequent fact requests.

Concurrent facts are batched; duplicate facts are coalesced within a repair.
Syntax results use a bounded browser cache as well as the existing host cache.
Filesystem facts are requested afresh for each repair.
Cancellation propagates from editing/disconnection through the worker to fetch and subprocess subscriptions.
The original five-second foreground budget, path search bounds and discovery depth/probe bounds remain.
High latency can exhaust those budgets sooner, leaving literal input instead of a repaired alternative.

Metadata is learned on demand and retained for ten minutes in the worker.
The original server's prompt-time prewarming is **not enabled** in this experiment; the portable prewarm implementation remains covered by tests.
A page reload loses browser matching/metadata/syntax caches, while the host retains native probe caches.
This makes first use and reload important performance cases.

## Reproducible measurements

```sh
npm run build
npm test
npm run test:browser
TEST_BASE_PATH=/t npm run test:browser
npm run bench:architecture
```

`bench:architecture` extracts the original engine using `git archive ba21e2c`, creates temporary executable/file fixtures, and compares exact candidate arrays.
It uses real filesystem and subprocess operations with a JSON transport and injected round-trip delay.
There are 3,007 command names and 5,000 history entries.
Each case has a cold run and three warm repetitions; the table uses warm medians.
Override `BENCH_RTT`, `BENCH_REPEATS` or `BENCH_BASE` to repeat other scenarios.
Raw results are written to `.test-artifacts/architecture-benchmark.json`; this run is preserved in `client-architecture-results.json`.

Measurements on this machine, Node 26.8.1 / Linux x64:

| Case | Warm baseline, 0 ms RTT | Warm client, 0 ms RTT | Warm baseline, 150 ms RTT | Warm client, 150 ms RTT | Warm fact requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| History (`Get in it.`) | 0.8 ms | 0.7 ms | 151 ms | 151 ms | 1 |
| Known schema (`git commit`) | 1.8 ms | 2.2 ms | 152 ms | 152 ms | 1 |
| Flags (`LSL`) | 1.1 ms | 1.1 ms | 151 ms | 152 ms | 1 |
| Python arguments | 3.8 ms | 4.1 ms | 154 ms | 455 ms | 3 |
| Learned nested command | 0.8 ms | 1.1 ms | 152 ms | 152 ms | 1 |
| Directory correction | 0.8 ms | 1.0 ms | 153 ms | 907 ms | 6 |
| Referenced filename | 8.6 ms | 9.3 ms | 160 ms | 763 ms | 5 |

Cold nested discovery at 150 ms RTT takes 777 ms versus 161 ms; cold directory repair takes 1,065 ms versus 153 ms.
Cold context transfer in this large fixture is about 173 KB uncompressed; a warm context-only exchange is about 378 bytes, excluding HTTP headers.
A changed catalog currently transfers the full catalog again, so a new history entry can resend unchanged command names.
Delta transfer is an obvious next optimization.

For warm schema repairs at zero injected latency, host operation time drops from about 1.76 ms to 0.26 ms; matching work has moved to the client.
These are elapsed host-call measurements, not CPU profiles or proof of improved server throughput.
Client compute runs in Node for this benchmark, not a mobile browser; it excludes worker startup, HTTP/TLS overhead, bandwidth limits, PTY rendering and phone battery/memory costs.
Baseline catalog preparation is not timed, so this is a controlled engine/transport comparison rather than a complete application benchmark.
Cold means engine metadata is cold; OS and native syntax/Python caches may be warm across cases.
The original background prewarm is excluded on both sides.

The worker and its main-thread bridge add roughly 9 KB of Brotli-compressed JavaScript to the app.
The existing WASM and font dominate static assets.
The service worker's generated asset manifest includes the worker, and offline/reconnect coverage still passes.

## Functionality evidence and limits

The existing behavior fixtures now run against the portable engine through native facts.
Additional tests cover JSON transport, batching, syntax reuse, live path deletion, context freshness, environment secrecy, malformed requests and independent help-route authorization.
All 64 unit tests pass.
Browser tests exercise the actual worker and production build, including delayed-request cancellation, Readline editing, Python flags, Git aliases, literal choice, IME, shortcuts, mounted URLs, offline loading and reconnects.
Transport checks preserve duplicate-command rejection, stale-edit rejection and 300 KB+ acknowledged output.
All 84 benchmark comparisons (7 cases × 3 RTTs × 4 runs) produce identical candidate arrays to the baseline.

This does not establish universal functional equivalence.
Slow/deep traversal can hit deadlines, uncommon command help can remain unresolved, and real Android/iOS performance and memory use still need device measurements.
The terminal byte path is unchanged; no terminal throughput improvement is claimed.

## What this means for an SSH relay

The separation makes an SSH-backed fact/terminal adapter plausible.
It does not implement SSH, SFTP or remote shell bootstrap.
A future adapter needs a PTY channel, file metadata/directory access (for example SFTP), and restricted exec channels for syntax/help/static inspection.
The current Bash integration communicates environment, commands, history and prompt state using local files and authenticated markers; remote equivalents must be designed.
Reconnect durability needs a retained remote session or multiplexer rather than an ephemeral SSH connection.

A relay can forward these channels while the browser owns interpretation.
A relay carrying **only terminal bytes** cannot preserve the current context-aware repair behavior without another channel for those facts.
Likewise, moving replay and final prompt/revision enforcement entirely into a disposable page would sacrifice disconnected sessions and protection from stale or duplicate commands.

Before pursuing a production migration, reduce transport dependencies while keeping decisions in the worker: prefetch bounded directory facts, send catalog deltas, validate multiple paths in one request, cache Python schemas by file version, and push context changes.
Then measure cold and warm behavior on phones over real SSH links, including bandwidth, battery, server CPU and saturated terminal output.
The evidence favors a client engine with a small, efficient host-data interface; it does not favor maximally fine-grained RPCs.
