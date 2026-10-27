# CI speed plan

## Summary

The required `Integration` check takes about 14 minutes with a warm cache, and the `Verify` job is the full critical path.
Browser harnesses use 9.3 minutes of this time: 5.2 minutes for the main pass and 4.0 minutes for reliability repeats.
Rust checks use 3.3 minutes, setup uses 1.1 minutes, and four of the last seven full verifications failed only because of browser harness timeouts.

The top three actions are: move the reliability repeats off the critical path, shard the browser harnesses across parallel runners, and stop verifying the same tree twice.
With two small fixes (remove the apt steps, fix two slow Rust tests), these actions decrease the critical path from about 14 minutes to about 4 minutes.
The repository is public, so more parallel jobs on standard runners cost no Actions minutes.

Secondary work removes duplicate compilation and checks, fixes cache scope so master and release runs reuse caches, and splits the longest harnesses so shards stay balanced.
Release runs can save about 10 minutes with a working Voxtype cache and package builds that run in parallel with verification.

## Baseline

Data is from run 40424784237 (warm cache, success).
Cold and failure data is from runs 40416916266, 40436879331, 40413106489 and 39730920060.

| Phase | Warm time | Notes |
| --- | --- | --- |
| Setup: checkout, Node, apt, Rust, caches, `npm ci`, Playwright | 1m07s | Run 40436879331 took 9m56s: apt got 25.9 MB at 50 kB/s for Playwright `--with-deps`. |
| `ci:quick`, vocabulary check, `cargo fmt` | 6s | The `CI` job already ran these checks. |
| `cargo clippy` | 10s | 2m07s with a cold cache. |
| `cargo test` compile | 53s | Only workspace crates compile, because dependencies come from the cache. |
| `cargo test` run | 1m51s | `http.rs` takes 62s and `vault.rs` takes 30s, and binaries run one after the other. |
| `cargo build` backend | 22s | Engine and server compile again because of the `ts` dev feature. |
| Frontend build | 4s | |
| `npm test`, `test:install` | 13s | `npm test` runs the 33 `ci:quick` unit test files again. |
| Browser harnesses, 3 jobs | 5m14s | 24 runs and 917 harness-seconds, close to the 306s ideal for 3 lanes. |
| Browser reliability, 18 runs | 4m03s | Reading, touch and selection harnesses, 3 times each with 1 and with 3 workers. |
| Total | 14m10s | |

## Priorities

The order is by wall time saved for each unit of effort.

### 1. Move browser reliability repeats off the critical path

Each run spends 4m03s to repeat three harnesses that the main pass already ran.
Run `verify:browser-reliability` in two parallel jobs, one for each worker count, after priority 2 is done.
Until then, run it only on pushes to `master` and on a nightly schedule, or set `BROWSER_REPEAT=1` for pull requests.
Keep the check, because it found real races in reading, touch and selection.

Saving: 4.0 minutes on the critical path.
Effort: workflow change only.

### 2. Shard browser harnesses across runners

The main pass uses 917 harness-seconds with 3 lanes on a 4-vCPU runner, so more lanes on one runner do not help.
CPU contention makes harnesses slower: reading took 18.9s with 1 worker and 31.4s with 3 workers, both with 400 ms delays.
Add a `BROWSER_SHARD=k/n` selection to `scripts/check-browser.mjs`, and run a matrix of 4 shards with `BROWSER_JOBS=2`.
Assign harnesses to shards longest-first from recorded durations.
Let each shard restore the Rust cache and build `libertty` (about 22s) and the frontend (4s).
A build job with an uploaded artifact also works, but it adds a serial step of about 80s before the shards start.
Move `cargo clippy` and `cargo test` to a parallel `rust` job, so 3.3 minutes of Rust work leaves the critical path.
Make `Integration` require all new jobs.

Saving: about 4 minutes after priorities 1, 5 and 6 (estimate); the longest harness, `workspace-browser.mjs` at 145s, then sets the browser wall time.
Effort: medium.
Side benefit: "Re-run failed jobs" then runs one shard again, not the full 14-minute job.

### 3. Decrease flaky failures

| Run | Failed harnesses | Failure point |
| --- | --- | --- |
| 40416916266 (CI, master) | plugins, herdr-reading, workspace | 12s iframe wait in plugins; `until` timeout at `test/workspace-browser.mjs:434` |
| 40436879331 (CI, PR #50) | reconnect | 30s `waitForFunction` timeout at `test/reconnect-browser.mjs:197` |
| 40413106489 (Release v0.2.12) | reading, terminal-touch | |
| 39730920060 (Release v0.2.9) | terminal-selection | |

Each failure costs a full rerun of 12 to 14 minutes.
At this failure rate, a change needs about 2.3 runs on average to pass, but the sample is small.
Find the root cause of each timeout above with the uploaded diagnostics.
Write a result line (harness, shard, pass or fail, duration) for every harness to the job summary and an artifact, to track flake rate and to balance shards.
Decrease CPU contention with priority 2, because the harness timeouts can be too short for a 4-vCPU runner.
Decide on a retry policy: one automatic retry for a failed harness in the main pass, reported as flaky, while the reliability check stays strict.

Saving: one full run for each failure that does not occur; this can be the largest saving if the failure rate stays near this sample.
Effort: medium to high, and the root causes are not known yet.

### 4. Do not verify the same tree twice

PR #50 merged at 05:30:28, 58s after its PR run 40455603592 started, and master run 40455704454 started at 05:30:30.
Both runs then did the full verification of the same content at the same time.
Release tags verify again a commit that the `master` push already verified.
After a successful verification, upload a small artifact named `verified-<tree hash>`.
At the start of verification, look for that artifact name with the artifacts API, and skip the remaining steps if it exists.
The artifacts API is repository-wide, so it avoids the branch scope of the Actions cache; the job needs `actions: read`.
On a push to `master`, cancel in-progress runs of the merged pull request.
After sharding, this also keeps two concurrent runs under the 20-job concurrency limit.

Saving: one full verification for each merge and about 12 minutes for each release.
Effort: medium.

### 5. Remove apt work from setup

`openssh-server` and `bash-completion` are already on the runner image: apt only upgraded `openssh-server` from 13.19 to 13.20.
Playwright `--with-deps` installs only fonts and package upgrades, and in run 40436879331 it took 8m48s.
Remove `apt-get update` and `apt-get install`, and keep `sudo mkdir -p /run/sshd`.
Cache `~/.cache/ms-playwright` with the `playwright-core` version in the key, and install with `playwright-core install --no-shell chromium`.
The harnesses set `executablePath`, so they do not use the headless shell.
Make sure that the missing fonts do not change the selection contrast results.
Also check whether a runner `/usr/bin/chromium` wins the selection in `scripts/check-browser.mjs:8`; if so, the Playwright download is not used.

Saving: about 25s for a typical run and no 9-minute apt stalls.
Effort: workflow change only.

### 6. Fix the two slow Rust tests

`a_silent_viewer_neither_pauses_the_shell_nor_stays_attached` in `crates/server/tests/http.rs:365` sleeps until 62s after connection, because the WebSocket heartbeat is 30s (`crates/server/src/http/socket.rs:175`).
Add a test-only heartbeat override, for example an environment variable that the server reads at startup, and set it to about 1s in this test.
`vault.rs` derives scrypt keys with `log_n = 15` and `r = 8` (`crates/server/src/vault.rs:33`) in an unoptimized build.
Add `[profile.dev.package.<name>] opt-level = 3` for `scrypt`, `salsa20`, `pbkdf2` and `sha2`.
This change also makes the debug backend faster for the browser harnesses.
As an option, use `cargo nextest` to run all test binaries in parallel.

Saving: about 60s and about 28s (estimate), plus about 10s from nextest (estimate).
Effort: small.

### 7. Remove duplicate compilation and checks

`libertty-server` has a dev dependency on `libertty-engine` with the `ts` feature.
Thus `cargo test` builds engine, server and `target/debug/libertty` with `ts`, and `cargo build -p libertty-server --bin libertty` then compiles engine and server again without `ts` (22s).
Use the binary that `cargo test` builds, or move the binding generation to a separate package so that both commands use one feature set.
After priority 2, this item is mostly for `npm run verify:local`, because the shards build only the binary.
`scripts/verify-local.mjs` runs `ci:quick`, the vocabulary check and `cargo fmt` again (6s); skip them in CI with an environment flag.
The `npm test` glob `test/*.test.ts` runs the 33 `ci:quick` test files again; run only the other files in CI.
The server has 25 integration test files, so `cargo test` links 25 large binaries; merge them into one `tests/it/` binary.
Measure the effect with `cargo test --no-run --timings` first.
Set `CARGO_PROFILE_DEV_DEBUG=line-tables-only` in CI to decrease link time and the 558 MB Rust cache.
Set `doctest = false` for the three crates, because they have no doc-tests.

Saving: about 1 minute (estimate).
Effort: small to medium.

### 8. Fix cache scope

`gh cache list` shows Rust, Node and Voxtype caches saved under `refs/tags/v0.2.x`.
A cache saved on a tag is available only to runs on that tag.
Thus master had no Rust cache when run 40416916266 started: `cargo clippy` took 2m07s and `cargo test` took 3m25s.
The Voxtype cache key is the same for v0.2.7 to v0.2.12, but each release built the daemon again for 8.5 minutes on both architectures.
Set `save-if: ${{ github.ref == 'refs/heads/master' }}` on `Swatinem/rust-cache` so pull request and tag runs do not save caches.
Build or restore the Voxtype daemon in a `master` job when its pin changes, so tag runs can restore it from the default branch.
As an alternative, publish the daemon as a `voxtype-mobile` release asset for each pinned commit.

Saving: about 3.5 minutes on cold runs and 8.5 minutes for each release.
Effort: small.

### 9. Shorten and split the longest harnesses

The longest harnesses are `workspace-browser.mjs` (145s), `herdr-browser.mjs` (117s), `dictation-browser.mjs` (97s), `browser.mjs` (87s) and `reconnect-browser.mjs` (70s).
Fixed waits include `test/dictation-browser.mjs:204` (16s), `test/browser.mjs:110` (6s), `test/reconnect-browser.mjs:258` (3s), `test/workspace-browser.mjs:180` (2.3s) and `test/plugins-browser.mjs:73` (2.2s).
Replace waits on page timers with the Playwright `page.clock` API, as the gesture harnesses already do.
Split each harness that takes more than 60s into two or three files with their own fixtures.

Saving: shard wall time from about 150s to about 70s (estimate).
Effort: medium to high.

### 10. Run release builds in parallel with verification

The `build` jobs need `verify`, so the package builds wait about 12 minutes.
Make `build` need only `source` and `companion`, and make `publish` need `verify` and `build`.
The `darwin-arm64` build does not use the companion daemon, so it can start at once.
With priorities 4 and 8, release wall time decreases from about 24 minutes to about 13 minutes, which is the macOS release build with full LTO.

Saving: about 10 minutes for each release.
Effort: small.

### Low priority

Skip verification for changes to documentation only; 2 of the last 30 `master` changes were documentation only.
`herdr-app-scroll-native.mjs` runs twice, and the lossy gzip run repeats all assertions of the plain run (25s of lane time).
Remove the plain run if another harness covers the default wire format.
Cache `node_modules` and `.test-artifacts/bin/herdr` to save about 10s for each job.

## Target pipeline

```text
quick (15s) ──────────────────────────────────────┐
rust: clippy + tests (about 2 min) ───────────────┤
browser shard 1..4: build + harnesses (about 4 min) ─┼─> Integration
reliability, 1 and 3 workers (about 4 min) ──────┘
```

The projected critical path is about 4 minutes, before the flake fixes.
Priority 9 decreases it to about 3 minutes.

## Suggested order

1. Priorities 1, 5 and 6: small changes that save about 6 minutes.
2. Priority 2 with the parallel `rust` job.
3. Priorities 4 and 8.
4. Priorities 3, 7, 9 and 10.
