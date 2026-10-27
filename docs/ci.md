# CI checks

The [CI workflow](../.github/workflows/ci.yml) runs quick and full verification on pull requests, merge queue candidates and pushes to `master`.
The quick CI target is 30 seconds or less from job start, with a 20-second limit on its JavaScript check command and a one-minute job timeout.
It uses the runner's existing Node and Rust tools and a shallow checkout without installing dependencies or restoring caches.
Require the `Integration` check before merging.
This check succeeds only when the quick `CI` job, Rust and unit tests, all four browser shards and any required reliability jobs succeed.

## Main checks

`npm run ci:quick` checks JavaScript and TypeScript syntax, parses JSON, verifies contract asset checksums and runs an explicit set of dependency-free unit tests.
It includes untracked source files and excludes deleted files so it also works before staging a commit.
These tests cover dictation state, reconnects, wire messages, input editing, plugins, Herdr space layout and other frontend logic.
The workflow also checks Rust formatting and the canonical command and speech vocabulary without compiling Rust.

```sh
npm run ci:quick
cargo fmt --all -- --check
npm run contracts:vocabulary -- --check
```

## Full local and release checks

[AGENTS.md](../AGENTS.md) routes agents to the [code changes skill](../.agents/skills/libertty-code-changes/SKILL.md) for required local validation before creating a commit or merging and CI runs the same full checks before merging.
Run the following with the Node version pinned in `build/release-config.json`, Rust with native dependency build tools, Chromium, OpenSSH server and Bash completion available.

```sh
npm ci
npx --no-install playwright-core install --with-deps chromium
npm run verify:local
```

[scripts/verify-local.mjs](../scripts/verify-local.mjs) runs fast checks, formatting, native Clippy, Rust tests, the frontend build, remaining JavaScript and contract tests, installer fixtures and browser checks in sequence.
It reuses the backend built by `cargo test`.
Verification sets `LIBERTTY_DEV_SKIP_BUILD=1` so development test launchers use that existing binary.
Set this flag only after building the backend for the same tree.
Set `VERIFY_QUICK_DONE=1` only when quick checks, vocabulary and formatting already passed for the same tree.
The Rust CI job uses this flag because the required quick job runs those checks separately.
Release verification runs quick checks in its Rust job unless a caller explicitly supplies a separate required quick check.
Standalone `npm test` discovers all unit files; full verification omits the quick unit files it already ran.
The installer fixtures remain in `npm run test:install`.
Rust integration modules share one `tests/it/main.rs` binary, and crates without documentation examples disable doc-tests.
CI uses `CARGO_PROFILE_DEV_DEBUG=line-tables-only` to reduce debug linking and cache size.
An incremental test rebuild with cached dependencies took 22.10 seconds before consolidation and 9.74 seconds after consolidation on the development machine.
Development builds optimize `scrypt`, `salsa20`, `pbkdf2` and `sha2` so key derivation retains production parameters without slow debug cryptography.
The silent-viewer test uses a debug-only `LIBERTTY_TEST_HEARTBEAT_MS` override and four output windows of data without expensive repeated terminal scrolling.
It keeps heartbeat traffic active without acknowledging output until the shell completes, then stops all traffic to check cleanup.
Release builds retain the fixed 30-second heartbeat and ignore the test override.
[scripts/check-browser.mjs](../scripts/check-browser.mjs) contains the single explicit browser list used by both local validation and the Linux release checking job.
It covers native repairs, SSH, reading, Herdr, plugins, pairing, reconnects, gestures, touch, dictation, files and workspace behavior.
It first downloads and verifies the pinned Herdr release, which the dictation, spaces, resize, flash and fullscreen scrolling harnesses use as the real native integration.
Local validation runs three harnesses at a time and reports every failure at the end; set `BROWSER_JOBS` to change the number.
CI runs four parallel browser jobs with two workers each.
Set `BROWSER_SHARD=k/n` to run one shard, with harnesses assigned longest-first from recorded durations.
The current weights come from the complete local scenario report and can be refreshed from CI result artifacts.
Terminal, dictation, Herdr and workspace checks each have three independent scenarios, and reconnect has two.
Each scenario creates its own backend, browser and temporary data.
The original npm commands still run every scenario for their suite, and `BROWSER_HARNESSES` accepts either an original suite name or a scenario file.
Page clocks advance idle-paint, idle-dictation, renderer-eviction and hidden-plugin timers without real waits.
Snapshot replay waits for backend completion, while native input delivery and the short held-handshake staging wait retain real time.
The full suite has 32 browser cases, and no case exceeded 42 seconds in the measured local run.
Fullscreen Herdr scrolling runs once with lossy gzip, while the real native resize harness also verifies default wire negotiation.
Each shard builds its own backend and frontend while Rust lints, Rust tests, JavaScript tests and installer checks run in another job.
Verification uses OpenSSH and Bash completion from the Ubuntu runner image and only creates the SSH daemon runtime directory.
Chromium is cached by the pinned `playwright-core` version and installed with `--no-shell`, without apt updates or dependency upgrades.
Installed Node dependencies are cached by platform, architecture, Node version, manifests and the post-install repair script.
The pinned Herdr binary is cached by version and checksum, and each use verifies its checksum and execute permission.
CI sets `CHROME_PATH` and `CHROMIUM` to the Playwright executable so system Chromium cannot shadow it.
Rust, npm and Chromium caches are restored on every ref but saved only from `master`.
The separate companion cache workflow warms both Linux Voxtype architectures when release pins or companion workflows change on `master`.
Its daily run also covers compiler updates without adding daemon builds to the required `Integration` check.
Every existing application harness remains available through its original npm command or `node test/<harness>.mjs`.
The helpers in `test/support/browser.mjs` wait for a connected, visible shell before entering a new command or transcript.
For native sessions, they also wait for Readline's bracketed-paste enable sequence.
This passive check waits until Readline restores raw input after the prompt marker without sending input-line probes that can race with history navigation.
The observer follows every page and preserves confirmed input mode when the same prompt reconnects.
Input helpers restore focus through an intentional touch or mouse action and confirm that the textarea is editable and focused.
Commands and reading choices record the current prompt so later input waits for a newer prompt after returning from a reader or switching tabs.
Use `waitForShell` with `visible: false` only when observing command completion in a background terminal.
Synthetic touch sequences dispatch immediate events in one browser call and select interior text outside the 40-pixel edge-scroll zone.
Long presses and edge scrolling advance the Playwright clock explicitly, while native taps and selection checks retain real browser event delivery.
The shared browser launcher saves traces, screenshots, browser errors and terminal state before pages or contexts close.
The browser runner keeps failed harness output and diagnostics in `.test-artifacts/browser/` and removes diagnostics for successful harnesses.
Every attempt is recorded in `.test-artifacts/browser-results-*.json` and the GitHub job summary with its harness, shard, repetition, result and duration.
CI retries a failed main-pass harness once and marks a retry pass as flaky while keeping the first attempt's diagnostics.
Set `BROWSER_RETRIES=1` to use this policy locally; local validation defaults to no retries.
Direct harness commands retain their diagnostics in the same directory.
Release checks upload these files even after a failure.
Pushes to `master`, nightly CI, manual CI and release verification also run `npm run verify:browser-reliability` against the built application.
Pull requests and merge queue candidates run each harness once and omit these additional repeats.
This command repeats reading, touch and selection checks three times each with one worker and three workers.
CI runs these worker counts in separate parallel jobs; set `BROWSER_RELIABILITY_JOBS` to `1` or `3` to select one locally.
It delays ready-state and input-line responses by 400 milliseconds in an ordered WebSocket proxy and delays synthetic gesture calls by 400 milliseconds.
Every repetition must pass, and a later pass does not clear an earlier failure.
Reliability checks always disable retries.
Set `BROWSER_REPEAT` to change the repeat count or `BROWSER_HARNESSES` to select comma-separated harness names when running `verify:browser` directly.
Each harness has an eight-minute limit, configurable through `BROWSER_TIMEOUT_MS`, after which the runner terminates its process group and preserves its output.
Use `npm run format:workspace` to format the workspace entry point and modules with the configured 100-column width, or `npm run check:workspace-format` to check them without editing.
`npm run verify:package -- release/libertty-vVERSION-PLATFORM.tar.gz` retains packaged browser coverage locally by running both smoke checks and the browser suite against the extracted archive.
The deleted tests covered only the removed CI suite selector and build manifests, while useful package checksum, permission, metadata and companion checks remain in `test/package-release.test.mjs`.

To rerun browser checks against an existing development build, use:

```sh
npm run verify:browser
```

The scripts use `CHROME_PATH` or `CHROMIUM` if supplied, otherwise system Chromium or the Playwright-managed executable.
On Linux, ensure the SSH daemon can use its runtime directory, normally `/run/sshd`.
macOS needs modern Bash, with `LIBERTTY_BASH` pointing to it and `LIBERTTY_GIT_COMPLETIONS_FILE` pointing to Git's Bash completion script when running full local validation.

The [Release workflow](../.github/workflows/release.yml) runs on `v*` tag pushes and manual dispatch.
Parallel Linux x64 jobs run native checks and browser shards while each supported platform builds, packages and smoke-tests its actual shipped archive once.
Linux packaging waits for the pinned companion, macOS packaging starts after source resolution, and publication waits for verification and every package.
The reusable [verification workflow](../.github/workflows/verify.yml) provides the same checks for CI and releases.
Pull requests verify the synthetic merge commit, merge queues verify the candidate commit and releases verify the resolved release commit.
CI skips full verification when the complete Git comparison contains only Markdown or static documentation files.
The comparison includes deletions and both sides of renames, and mixed code changes retain full verification.
The required quick job still runs, and skipped documentation checks do not produce a verified-tree marker.
Nightly and manual CI always run fresh full checks, including strict browser reliability repeats.
Successful verification uploads a `verified-<Git tree hash>` marker for 30 days, with a separate reliability marker when those repeats pass.
CI and releases reuse a marker only after checking that its completed CI or release run succeeded and that the run's source commit has the same tree.
Expired markers, fork runs, different source trees and failed or incomplete runs do not skip checks.
Lookup errors run fresh checks, and nightly or manual CI always runs fresh checks.
Pushes to `master` cancel unfinished CI runs for the merged pull request.
Manual runs create downloadable artifacts without publishing a release.
See [releases.md](releases.md) for pins, packaging and publication.

## Recorded timeout fixes

The archived runs in `speed-ci.md` predate several existing harness fixes.
The following evidence comes from their uploaded browser states, traces and job logs.

| Failure | Evidence and correction |
| --- | --- |
| Plugins, run 40416916266 | The SSH dialog was still connecting after a trust conflict; `502e6d4` waits for the final session response and dialog close. |
| Herdr reading, run 40416916266 | Input followed a cancelled mobile touch with the keyboard closed; `232aefb` restores intentional input focus and `7fe79e9` shares shell observation. |
| Workspace, run 40416916266 | The shell entered program mode without opening the captured SSH tab; `60b506e` waits for passive Readline readiness and asserts the captured command before waiting for a tab. |
| Reading, run 40413106489 | The reading choice never appeared after input; shared prompt readiness and intentional focus replace direct input into a closed mobile keyboard. |
| Touch and selection, runs 40413106489 and 39730920060 | Long-press assertions expired; `feedffa` advances gesture timers explicitly and selects outside the edge-scroll zone. |
| Reconnect, run 40436879331 | The awaited Ctrl+C was absent from sent input and the mobile textarea was read-only; the reconnect harness now restores intentional input focus before freezing replay painting. |

The earlier release runs did not retain browser traces, so their logs identify the failed assertions but cannot prove every event ordering detail.

## Local performance checks

Performance comparisons run on the developer's machine through standalone scripts, with the commit and merge requirements in the [code changes skill](../.agents/skills/libertty-code-changes/SKILL.md).
The manual GitHub performance workflow has been removed because shared runners add noise to latency comparisons.

```sh
npm run verify:performance
BENCH_SUITE=shared npm run bench:architecture
npm run bench:workspace
```

[scripts/check-performance.mjs](../scripts/check-performance.mjs) builds the optimized native wire host, measures JSON and compression under fast and mobile profiles, then enforces the existing transport latency budgets.
The architecture benchmark retains correctness, cold and warm latency, request-count checks and reversed-order confirmation of suspected regressions.
Its default `0e0646c` reference is the historical TypeScript architecture, and `BENCH_BEFORE_MASTER` and `BENCH_BEFORE_CLIENT` can select other compatible TypeScript references from local Git history.
The workspace benchmark retains startup, reload, echo and submit measurements against its historical `2a99127` reference, selectable with `BENCH_BEFORE`.
These historical loaders require the old TypeScript server layout and do not accept arbitrary modern Rust revisions as baselines.
Reports are written to ignored `.test-artifacts` files, and historical comparisons should be reviewed alongside current measurements rather than treated as current phone performance guarantees.
