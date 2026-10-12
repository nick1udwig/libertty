# Rust migration

Issue [#10](https://github.com/nick1udwig/termai/issues/10) migrates the backend and shared engine while preserving the frontend and saved backend data.
The reference revision is `455386b`, and the implementation branch is `feat/rust-backend`.
The contract inventory, regression matrix, reference fixtures and reference baseline were captured before production conversion.
The Rust executable is the default for source commands, release packaging and installed services.
The TypeScript backend remains available through the explicit reference commands and `TERMAI_BACKEND=node` packaging for parity and rollback checks.

## Implementation status

This branch implements migration contracts, baseline capture, the full Rust suggestion engine, a production Wasm worker, and a Rust HTTP/WebSocket executable for local and SSH sessions.
The same engine crate builds as a native library and JSON command-line oracle and as browser WebAssembly.
The reference corpus contains 16,404 original pure fixtures, 156 additional ECMAScript Unicode and quoting fixtures, 331 synthetic asynchronous fixtures, 138 asynchronous fixtures captured from unchanged original tests using real host adapters, and 48 prewarm cache steps.
Native Rust and Chromium compare complete candidate arrays, scores, ordering, literal alternatives and recorded host operations.
The asynchronous runtime batches independent host operations, caches facts within a request, limits active requests to 32, rejects foreign or incomplete replies, and drops request-owned futures when cancelled.
The JavaScript adapter aborts callbacks, ignores late results, and releases Wasm allocations on success, failure and cancellation.
The Wasm boundary limits individual inputs to 64 MiB, outstanding buffers to 64, and their combined bytes to 128 MiB.
`termai_context` accepts `PreparedEngineContext` and installs the latest immutable catalog and environment under a monotonically increasing context ID.
`termai_suggest_prepared` accepts `PreparedEngineRequest`, and warm repairs reuse the catalog until its version key or environment changes.
Replacing a context rejects its old handle for new calls while pending requests retain their original snapshots, and reset releases both contexts and requests.
Native directory callbacks carry typed immutable arrays directly, and directory snapshots share their storage until a caller edits a copy.
The Wasm bridge imports adapter-owned immutable directory arrays once and pins opaque references in the same exchange that resumes each reply batch.
The parsed directory cache retains at most 32 arrays and 30,000 entries, with request pins preserving snapshots through concurrent cache eviction.
Changed arrays receive new monotonically increasing handles, reset releases the cache, and arbitrary mutable callback values continue through the JSON interface.
Directory versions and the existing verification and retry checks remain active on every repair.
Directory matching borrows entry names and computes the spoken UTF-16 spelling once per component instead of cloning every matching entry.
The native backend calls the same typed executor directly, and copy-on-write catalog arrays preserve snapshot isolation without repeated JSON conversion or history cloning.
Request-owned host facts share immutable JSON values, and deterministic command and history indexes reuse shared arrays without rehashing unchanged inputs.
The production worker loads the fingerprinted Wasm asset through the normal frontend build and preserves cancellation, directory verification and retry behavior.
Deterministic command and history indexes have bounded caches keyed by every input value, while host facts and learned metadata retain their request and session scopes.

The server crate implements pairing persistence and HTTP authorization, owned local PTYs, private shell markers, Readline editing, prompt and input revisions, replay and acknowledgements, native suggestions, client facts, and vault encryption and OpenSSH key handling.
Native filesystem, help, syntax, programmable completion and static Python inspection adapters use bounded and cancellable subprocesses.
Local file listing, folder creation, exclusive streaming uploads, single-use downloads, optimistic text edits, bounded copy/delete, transfer retention and reading captures are integrated into the Rust API.
The unchanged Bash hooks are embedded in the executable, and native tests cover actual Readline behavior, binary captures, attachment replacement, stale edits, command deduplication and large output.
Synthetic Voxtype daemon tests cover authenticated discovery, capability negotiation, bounded Opus frames, final transcript insertion, terminal control rejection and explicit cancellation.
The existing browser harness passes against the Rust executable in server mode and client mode under `/terminal/`, and the mounted Reading Mode browser harness also passes.
Synthetic fixtures verify encrypted and unencrypted OpenSSH imports, saved credential reuse, host pins, key fingerprints, private-file modes, and Node-to-Rust-to-Node rollback.
OpenSSH import preserves the original private-key bytes and accepts both the reference writer's 64-column wrapping and ordinary OpenSSH wrapping.
Forty synthetic legacy-key fixtures cover traditional RSA, DSA and EC PEM, encrypted imports, PuTTY passphrase integrity, incorrect passwords, and the reference's rejection of generic PKCS8 imports.
System SSH configuration resolution preserves identity-file and agent ordering, external references, known-host verification, and native fallback for unsupported shell invocations and SSH configuration.
Real SSH tests cover host-key verification, failed authentication, bounded and cancelled fact channels, remote Bash PTYs, SFTP file actions, reading, and transport cleanup.
SSH sessions retain the reference's client-engine mode.
Herdr snapshots, actions, status tracking, mobile terminal ownership, incremental frames, scrolling, dictation, remote Unix socket forwarding, and notification persistence are implemented.
The full Herdr and file browser suites pass against the Rust backend, including remote SSH sessions.
Notification tests use synthetic subscriptions and mocked deliveries to verify encryption, saved VAPID identity, owner isolation, foreground suppression, acknowledgements, restart behavior, and expired devices.
The inventory maps all 254 named tests across 83 harnesses and 61 modules to native equivalents or explicit retained-harness justifications.
Retained Bash utilities are byte-identical to the reference source, with a contract assertion checking the embedded bytes.
Rust also serves the unchanged development pairing page and proxies loopback Vite assets and hot-reload sockets behind native authorization.
Release archives contain the native executable and production Wasm, and installed launchers execute Rust directly with the existing configuration format.
The three-platform CI matrix is configured, but only the Linux x86_64 checks have been run locally.
The release workflow requires the complete regression and platform matrix before publishing.

## Run the migration checks

Install Rust 1.89 or later and add the `wasm32-unknown-unknown` target before building the browser artifact.
The browser parity harness requires Chromium, selected through `CHROME_PATH` when it is not available at `/usr/bin/chromium`.

```sh
npm ci
rustup target add wasm32-unknown-unknown
npm run migration:schemas -- --check
npm run migration:inventory -- --check
npm run migration:vocabulary -- --check
npm run test:contracts
npm run test:rust
npm run test:rust-state
npm run build:rust-engine
npm run test:rust-browser
npm run build
npm test
cargo build --locked -p termai-server --bin termai
TEST_BACKEND=rust TEST_ENGINE=server TEST_PORT=3137 npm run test:browser
TEST_BACKEND=rust TEST_ENGINE=client TEST_PORT=3138 TEST_BASE_PATH=/terminal npm run test:browser
TEST_BACKEND=rust TEST_BASE_PATH=/terminal npm run test:reading
TEST_BACKEND=rust node test/files-browser.mjs
TEST_BACKEND=rust npm run test:herdr
TEST_BACKEND=rust npm run test:workspace
npm run test:rust-herdr
```

`npm run migration:fixtures`, `npm run migration:host-fixtures`, and `npm run migration:state-fixtures` regenerate independent TypeScript oracles and synthetic state.
Do not regenerate expected outputs to accommodate a Rust mismatch.
The native oracle accepts one `{operation, args}` JSON request per line through `cargo run --locked --release -p termai-engine`.
The asynchronous Rust `Runtime` and JavaScript `WasmEngine.invoke` interfaces support full suggestions, discovery, completion, file and directory repairs, candidate validation, and session metadata caching.
`npm run migration:async-fixtures` and `npm run migration:prewarm-fixtures` record unchanged reference behavior for real host assertions and prewarm cache steps.

## Contracts and inventory

`contracts/schemas.json` contains JSON Schema 2020-12 definitions generated from the five existing protocol modules, shared engine data types, help metadata, and SSH key metadata.
`contracts/engine-operations.json` defines operation-specific argument tuples, optional argument nulls, result schemas and ignored trailing callback arguments.
`contracts/regression-inventory.json` records every backend and shared engine module and every existing test harness with its assertions, destination, and retention justification.
Run `npm run migration:schemas` and `npm run migration:inventory` to regenerate these files, or append `-- --check` to detect drift.
Optional properties are omitted, and null is accepted only by explicitly nullable unions or the fact result for a missing file or description.
Unknown object fields and terminal message tags are ignored for compatibility, while unknown fact operation kinds and Herdr actions are rejected before starting work.
All JSON strings use Unicode, all host paths use POSIX syntax, and the `x-utf16MaxLength` and `x-utf8MaxBytes` schema keywords distinguish reference text limits from standard JSON Schema character counts.
Integer counters remain within JavaScript's safe integer range, and scores retain their full floating-point precision.
Raw terminal output remains UTF-8 JSON text, binary file streams remain uninterpreted bytes, and private shell markers and Herdr frames use standard base64.
The schema generator does not replace runtime authorization, prompt checks, byte budgets, or context validation.

## HTTP and WebSocket behavior

Every HTTP request must pass the configured Host allowlist, and every state-changing API request must pass the same-origin or explicit origin allowlist check.
Pairing credentials use either the `termai` cookie or a bearer token, and the cookie retains the mounted path, HttpOnly, SameSite=Strict, one-year expiry, and Secure attribute for HTTPS.
`/healthz` is unauthenticated, `/api/connect` validates the pairing token, and download GET requests authenticate through a short-lived single-use ticket.
Other API requests require a paired credential, and session names are scoped by owner with a limit of 32 open or opening sessions.
`contracts/http.json` inventories methods, paths, schemas, body limits, authentication, response encodings, and error statuses.
`contracts/ws-lifecycle.json` records attachment transitions, replay and flow-control rules, revision guards, ticket ownership, encodings, and disposal behavior in machine-readable form.
Errors keep the JSON shape `{error, needsSecret?, fingerprint?, changed?}`, no-store caching, and existing human-readable messages.
JSON requests require the JSON content type and an object body, with a default limit of 16,384 UTF-16 units in the reference implementation.
Herdr action bodies allow 64 KiB, and file action bodies allow 256 KiB.
The port must preserve these observed limits or explicitly demonstrate a compatible replacement with differential tests.
Fact batches contain 1–64 operations, at most eight help/description/completion operations, and at most eight entry/lookup operations.
Validate the entire batch before executing any callback, and reject stale context keys both before and after collecting host facts.
Fact paths are absolute, contain no NUL, and have at most 4,096 UTF-16 units.
Entry limits range from 1 to 10,000, directory versions have at most 256 units, commands have at most 4,000 units without control characters, and verified help routes have at most three names.

WebSocket upgrades require a valid Host, permitted Origin, live owned session, and paired credential or matching terminal ticket.
Terminal tickets expire after 15 seconds, are single-use, and are limited to 256 pending tickets.
Text and binary WebSocket payloads have a maximum size of 128 KiB.
Binary terminal messages carry framed Opus dictation audio, and binary payloads must never be interpreted as JSON input.
Terminal text messages use the `ClientMessage` and `ServerMessage` schemas, and Herdr metadata uses `HerdrMessage`.
Only the newest terminal attachment may send input, and replacing an attachment closes the previous socket with code 4001.
Prompt and input revisions guard replacements, commands, Readline snapshots, and dictation against stale requests.
Local resize messages clamp integer sizes to 2–300 columns and 2–120 rows, while Herdr messages reject sizes outside 1–1,000 cells.
Command IDs are deduplicated with a 1,000-result cache, and an accepted replacement must edit without submitting.
Output sequences are monotonic per stream, and acknowledgements cannot acknowledge unsent output.
Replay retains at most 2 MiB and 16,384 chunks, and live output pauses at a 128 KiB acknowledgement window.
Reconnects report stream changes and replay gaps through `hello`, reset safely, and replay pending captures and transfers.
Disconnected shells expire after one hour, while process shutdown disposes sessions, temporary captures, callbacks, subscriptions, and sockets.
Herdr connections are limited to 64 and retain their separate mobile resize authority, incremental-frame repaint behavior, and notification presence lifecycle.

## Engine and asynchronous host boundary

The Rust engine must have no filesystem, subprocess, terminal, HTTP, or network side effects.
Native and WebAssembly targets must execute the same crate and use the same catalogs, metadata, directory facts, ranking, quoting, and validation implementation.
The pure JSON interface uses `{operation, args}` and returns a JSON value, with undefined reference results represented by null only at this calling interface.
Host callbacks use request-scoped IDs and the `HostRequest`, `HostReply`, `HostError`, and `HostCancel` schemas.
Each callback returns one result per operation in the original order, and callback failures reject the Rust request without becoming a successful empty fact result.
One request may have concurrent independent callbacks, but callback IDs and contexts must never be shared between sessions.
Cancellation must stop queued work, terminate abandoned subprocesses, release pending Rust futures, and ignore late replies.
Cancelling one subscriber must not cancel coalesced help work while another subscriber still needs it.
Worker reset cancels all active requests, and superseding a foreground repair cancels its previous request.
Directory snapshots retain version checks and retry changed listings at most twice before reporting failure.
Environment values stay on the host, and browser context includes only home, catalog, and discovery keys.
Native adapters may supply local filesystem and syntax/completion processes, while browser adapters obtain facts from the authenticated session API.
`AsyncEngineRequest`, `EngineResume` and `EngineStep` specify the implemented cooperative executor's start, reply and completion messages.
Request and callback IDs are positive 32-bit integers, and a callback ID must belong to the engine request being resumed.
Each callback batch has at most 64 ordered operations and accepts either ordered successful `values` or per-operation `results` containing a value or an error.
`termai_directories` accepts `EngineDirectoryPins` for an active request, imports or reuses immutable arrays, and rejects invalid, duplicate, stale or oversized handle batches before changing state.
Packed `HostResult` variants reference that request's pinned entries and carry the original lookup version and completeness metadata.
Unpinned or cross-request references cancel only the request being resumed, and pending pins survive global cache eviction until their reply is consumed or their request ends.
A `HostError` rejects the entire callback batch, while per-operation errors retain the reference operation's own error handling.
Host clocks use finite nonnegative monotonic milliseconds supplied by the adapter, and engine request IDs increase strictly and are never reused in a runtime instance.

## Persisted data compatibility

The pairing token remains in `pairing-token` with a trailing newline, mode 0600, and a private 0700 parent directory.
The paired client file retains version 1, the SHA-256 token digest, and up to 256 SHA-256 credential digests in `paired-clients.json`.
Rotating the pairing token clears old credentials, and malformed stored pairings fail closed rather than generating replacement credentials silently.
Vault data remains in `vault.json` with `keys` and `knownHosts` arrays.
Stored private keys retain scrypt with N=32768, r=8, p=1, a 16-byte salt, a 32-byte key, and AES-256-GCM with a 12-byte IV and 16-byte tag.
Salt, IV, tag, and ciphertext remain standard base64 without an additional authenticated-data field.
SSH fingerprints remain `SHA256:` followed by an unpadded standard-base64 SHA-256 digest of the SSH public-key wire bytes.
External key references remain `{type: file|agent, path}` with absolute paths, and private material must never appear in list responses.
Preserve key UUIDs, names, ISO timestamps, public keys, and host/port pins, and never silently replace a changed host fingerprint.
Vault mutations remain serialized and atomic, and concurrent updates must not lose entries.
Notification state retains its existing subscription keys, device ownership digests, source watches, and VAPID identity across restarts.
Browser host profiles, keys, plugins, workspaces, and service-worker cache formats are retained because their owning frontend remains TypeScript.
No persisted-data rewrite is required for a compatible port, and rollback must be tested by opening Rust-written state with the reference implementation.
Compatibility fixtures must use synthetic credentials and keys rather than material from the user's home directory.

## Regression baseline and performance gates

`npm test` passes 214 tests with one existing installed-manual skip, and `npm run test:install` passes all 26 tests on Linux x86_64 with Node 26.8.1.
`npm run build` passes against the reference implementation.
`npm run migration:fixtures` executes the unchanged reference assertions through a recording loader and captures complete pure-engine arguments and results.
The corpus compares full arrays, ordering, scores, change descriptions, literal alternatives, quoted values, paths, Unicode, help flags, history, and pipeline parsing.
The corpus must remain an independent oracle and must not be rewritten to make Rust failures pass.
The recorded loader only instruments pure functions and does not replace process, filesystem, authorization, or browser assertions.
The recorder excludes individual records longer than 65,536 UTF-16 units, so the existing large-catalog stress assertions still require dedicated Rust equivalents and performance measurements.
The asynchronous corpus covers synthetic and original real-host behavior, and native adapter tests add actual Bash, PTY, shared cancellation and filesystem changes.
Every original standalone backend assertion has a checked native destination or an explicit retained-harness justification in the regression inventory.
Run the browser harness in each engine mode with dedicated ports, including `TEST_BASE_PATH=/terminal` in client mode.
Reading, development pairing/HMR, plugins, files, transfers, gestures, touch, workspace and Herdr harnesses exercise the Rust executable.
The native Herdr harnesses use the checksum-pinned supported Herdr executable, including mobile sizing, native scroll and shared spaces.
Linux ARM64 and macOS Apple Silicon run the same checks on their own runners, and the release workflow waits for all three platform gates before building publishable archives.

The architecture baseline uses `BENCH_SUITE=shared`, both before references set to `.`, the after reference set to `.`, and RTTs of 0, 50, and 150 milliseconds.
Rust comparisons use at least 31 warm CPU repetitions through `BENCH_CPU_REPEATS` and three warm network repetitions through `BENCH_REPEATS`.
The benchmark records cold and warm latency, warm p95 latency, foreground request counts, bytes, host time, and separate idle push costs for every case.
Native measurements additionally report engine latency separately from peer-process IPC.
Native and Wasm candidate results must match the reference exactly, and cold and warm foreground request counts must not increase in either mode.
Median warm latency must stay within the larger of 20 percent or 0.15 milliseconds of the corresponding reference measurement on the same runner.
For sufficiently sampled CPU cases, a warm regression fails only when the 95 percent median intervals confirm it exceeds that allowance, and raw medians and intervals remain in the report.
Cold latency retains the larger of 20 percent or 10 milliseconds as its allowance for subprocess startup variation.
Use at least 31 warm CPU samples and rerun a noisy failed latency measurement before declaring a regression, while candidate or request-count failures always fail immediately.
Cold browser initialization and Wasm download time must be measured separately and included in the browser performance report.

## Recorded verification and release gates

Local verification ran on Linux x86_64 with Node 26.8.1 and Chromium 151.
The full architecture run passed 432 complete candidate-array comparisons across 108 measurement rows, nine cases, both engine placements and RTTs of 0, 50 and 150 ms.
Every cold and warm foreground request count matched its TypeScript reference, and every latency measurement passed the predefined 20 percent or 10 ms threshold.
The actual browser report measured 38.4 ms for Wasm loading and initialization, including 5.1 ms of local download time, for a 3,371,469-byte artifact.
These local measurements exclude real mobile hardware, production bandwidth limits and external TLS overhead.
Reports are written to `.test-artifacts/rust-browser-initialization.json` and the architecture benchmark's configured JSON output.
Local checks passed 90 native Rust tests, 230 frontend/reference tests with one existing skip, 27 installer tests, the contracts and both mounted engine modes.
Real SSH/SFTP, development HMR, Herdr, saved-data rollback, installer rollback and packaged execution are checked alongside the browser and performance gates.
The three-platform workflow repeats the complete matrix on Linux x86_64, Linux ARM64 and macOS Apple Silicon and retains machine-readable reports as artifacts.
Linux ARM64 and macOS jobs were configured but could not be executed in this Linux x86_64 workspace.
The release workflow depends on that full parity workflow and then verifies the final companion-equipped release and installed launcher before publishing.
Package smoke checks exercise both engine modes under a mounted path, and full browser checks additionally launch the extracted native release executable in both modes.

The first optimization comparison uses 62 warm samples per case and execution mode across forward and reverse run orders, with 2,304 exact candidate-array comparisons.
That comparison measured faster native Rust medians in seven of nine cases and faster Wasm medians in six of nine cases.
History repair improved from 6.16 to 0.62 ms natively and from 7.42 to 1.60 ms in Wasm, compared with TypeScript medians of 1.83 and 2.35 ms respectively.
The directory optimization repeats the same 62-sample comparison and passes another 2,304 exact candidate-array comparisons.
Warm large-directory repair falls from 1.37 to 0.28 ms natively and from 2.20 to 0.61 ms in Wasm, improvements of 79.6 and 72.3 percent respectively.
The contemporaneous TypeScript medians are 0.47 ms natively and 0.535 ms in the client, so native Rust is 40.4 percent faster on this case while Wasm remains 14.0 percent slower.
Before the additional optimization round, native Rust measured faster medians in eight of nine cases, and Wasm measured faster medians in five of nine cases.
Exact-directory native medians are 0.185 ms for TypeScript and 0.22 ms for Rust, while the Wasm schema case is close at 1.76 ms for TypeScript and 1.845 ms for Rust.
The native benchmark includes its peer-process IPC, and Wasm CPU measurements run in Node rather than on a phone.
Detailed measurements are recorded in `.test-artifacts/speed-directory-optimization.json`, with both raw runs and the previous `.test-artifacts/speed-optimization.json` baseline retained alongside it.
The pure engine profiling example is available through `cargo run --locked --release -p termai-engine --example profile`.

## Additional optimization round

Native completions reuse at most two idle Bash workers and run each request in a fresh subshell with freshly sourced definitions.
Worker keys include the Bash executable, working directory and complete environment, and cancellation or invalid output discards the worker.
Session catalogs share function arrays, history-directory maps and environments, while prepared context replies reuse unchanged catalog JSON and discovery digests.
Flattened path strings are reused only after directory snapshots have been revalidated, including nested directories.
Native engine futures and host callbacks run together on a local executor using the application's shared I/O and blocking pools, with a standalone runtime fallback.
Common native host responses use typed values and request memoization uses typed keys instead of serialized JSON strings.
Generated static regex storage removes cache locks and pattern-string allocation for literal expressions, and discovery reuses unchanged context keys.
Candidate validation checks command membership without cloning the command catalog and retains explicit-input rules for private shell helpers.
The Wasm bridge combines directory imports with resume, reuses UTF-8 encoding buffers and streams initialization when the asset has the Wasm content type.
Filesystem catalog and listing scans batch their blocking operations, and validated directory snapshots retain exact and lazily folded name indexes for path spelling.

The additional optimization comparison pools 62 warm samples per case and execution mode across forward and reverse run orders, with 2,304 exact candidate-array comparisons.
Native Rust has faster warm medians and p95 latency in all nine cases, while Wasm has faster warm medians in seven of nine cases.
Native exact-directory repair measures 0.10 ms against TypeScript's 0.20 ms, and native large-directory repair measures 0.14 ms against TypeScript's 0.46 ms.
Native referenced-file repair measures 2.295 ms against TypeScript's 5.30 ms.
Wasm history repair measures 0.885 ms against TypeScript's 2.18 ms, and Wasm schema repair measures 1.345 ms against TypeScript's 2.195 ms.
The remaining Wasm median gaps are directory repair at 1.10 versus 1.00 ms and large-directory repair at 0.575 versus 0.535 ms.
These timings retain native peer-process IPC and measure Wasm in Node, so they do not establish equivalent mobile, startup or memory performance.
Detailed measurements are retained in `.test-artifacts/speed-six-optimizations.json` and its forward and reverse run files.

## Further optimization round

Standard Bash completion frameworks are prepared once when no custom startup scripts are present, and their file versions are checked before each reuse.
Custom startup scripts retain fresh sourcing, command-specific loaders remain isolated in child processes, and successful request-owned completion results can be shared across timeout budgets.
Symbol matching precomputes vocabulary keys and phonetic forms, limits edit distance to three reusable rows, and shares bounded deterministic text parsing caches.
Candidate search shares parent-linked argument and change trails, borrows flag definitions, and uses indexed command and history-frequency lookups.
Native callbacks use typed operations throughout the executor, while prepared Wasm calls send text directly and reuse validated input buffers.
Directory matching shares prepared names across immutable listing snapshots, and native candidate stat operations share one blocking-pool submission.
The Rust backend advertises compound repairs through context replies so dependent client repairs can execute near their host facts in one browser request.
Compound repairs bind the saved catalog to the current session context, collect missing path facts, revalidate used listings with bounded retries, and reject context changes before returning results.
Older servers retain the ordinary Wasm callback path because they do not advertise the capability.
The `.test-artifacts/architecture-second-six.json` comparison passes 1,440 complete candidate-array comparisons across 108 rows at 0, 50 and 150 ms RTT.
At 150 ms RTT, warm client Python repair measures 190.17 ms against 1,471.06 ms for TypeScript, nested help measures 163.76 against 481.07 ms, and referenced-file repair measures 153.01 against 759.37 ms.
Those cases reduce their foreground request counts from nine, three and five respectively to one.
Client rows identify native delegation explicitly rather than presenting those measurements as Wasm CPU performance.
This round does not meet the tenfold target in every case, and native peer IPC, injected RTT and Node-hosted Wasm retain their existing measurement limitations.
Local validation passes 102 Rust tests, 234 frontend and reference tests with one existing skip, and Chromium parity for 16,560 pure fixtures, 469 asynchronous fixtures and 48 prewarm steps.
Both mounted browser engine modes pass with the Rust backend, and native and Wasm Clippy checks pass with warnings denied.
The full architecture gate passes 1,440 exact candidate-array comparisons across 108 rows at 0, 50 and 150 ms RTT, with 31 warm CPU samples and three warm network samples per case and variant.
