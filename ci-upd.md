# CI review

The fast CI is fine as it is.
Almost everything else goes well beyond "fast CI, then build and publish."
The release path is also broken right now, and that matters more than the CI design.

## Fix first: releases are publishing with no files

- v0.2.0, v0.2.1 and v0.2.2 are published GitHub releases with 0 assets, and v0.2.2 is marked Latest.
- `install.sh:40` installs whatever release is marked latest, so a fresh install fails at the moment.
- Cause: `release.yml` runs when a release is published, so the release is public before its files exist.
  About 12 checking jobs then run before anything is uploaded.
  When any of them fails, the release stays public and empty.
- The recent failures came from a check that the generated contract files (`contracts/*.json`) match their source.
  The 3 unpushed local commits appear to fix that.
- Fix: start the release from a tag push (or a draft release), build and smoke-test, then create or publish the release with its files in the last step.
  That way a failed release never shows up as "Latest."

## What runs today

| Workflow | When it runs | Time | What it does |
|---|---|---|---|
| `ci.yml` | Every push and PR. | 11–16 s | Checks every JS/TS/JSON file parses, verifies asset checksums and runs 25 unit tests that need no dependencies. |
| `integration.yml` | Every push and PR. | ~6–7 min | Runs `cargo fmt`, Clippy twice, `cargo test`, the full build, `npm test`, installer tests, a Chromium install, browser tests chosen by changed paths and saved-data compatibility. |
| `rust.yml` | Called by release, or manual. | — | Runs the same checks on 3 platforms plus a release build, packaging and 2 smoke tests, then 9 browser jobs (3 suites × 3 platforms). |
| `release.yml` | Release published, nightly, or manual. | ~14 min when it passes | Runs `rust.yml`, builds the Voxtype dictation daemon from source, packages and smoke-tests again, then uploads. |
| `performance.yml` | Manual. | — | Runs a latency benchmark against the hard-coded commit `0e0646c`. |

## Item by item

### `ci.yml`: keep it

- It meets the 30-second goal and is built well: it's an explicit list, needs no installs, and has a hard timeout.
- It checks no Rust at all.
  `cargo fmt --all -- --check` takes a few seconds with the toolchain already on the runner and compiles nothing, so it's worth adding.
- `contracts:vocabulary --check` is a 6-line JSON check with no dependencies (in the local version), so it fits here too.
- Rust compile errors can't be caught reliably in under 30 s from a cold cache.
  Accept that, or rely on a local pre-push hook.

### `integration.yml`: a second, 6-minute CI on every push

This goes against the goal of a fast main CI.

- The path-based selection barely helps.
  It only decides which browser suites run.
  The `build` job doesn't depend on it and always does the full Rust, frontend and Chromium work, even for a docs-only change.
- It has its own list of test suites.
  `scripts/ci-suites.mjs` groups the tests one way and `rust.yml` lists them again inline with different groupings, so the two will drift apart.
- The path-to-suite rules are hand-maintained, and `test/ci-suites.test.mjs` exists only to test the CI's own selection logic.
  That's a sign the machinery costs more than it saves.
- Recommendation: delete it, or make it manual-only.
  Its useful parts belong in the release checks.

### `rust.yml`: useful checks, but heavily duplicated

- Formatting and Clippy run on all 3 platforms.
  Formatting doesn't depend on the platform, and only 4 `cfg(...)` attributes in `crates/` are platform-specific, so once on Linux is enough.
- The release package is built and smoke-tested up to 3 times per platform:
  - in `parity`, with dirty source allowed and no dictation daemon;
  - again in the `terminal` browser suite;
  - again for real in `release.yml`.
- The copies that aren't the shipped one prove little.
- Running the full browser tests on 3 platforms is the most expensive part.
  Most of those tests exercise frontend behaviour that doesn't change by OS.
  The real platform risk is the terminal process, the shell, SSH and Herdr, and smoke-testing the packaged build on each platform covers that.
- Recommendation: use one Linux x64 job as the release check (fmt, Clippy, `cargo test`, `npm test`, optionally the browser tests).
  On each platform, just build, package and smoke-test.
- Its `concurrency` setting refers to `pull_request`, but this workflow never runs on PRs, so that part does nothing.

### `release.yml`

- Nightly cron (`17 8 * * *`): remove it.
  It runs the whole 3-platform pipeline every day whether or not anything changed, and it's currently failing every day.
  It's also unrelated to building or publishing.
- Building the Voxtype daemon from source is legitimate today, but in the wrong place.
  It's the slowest step that isn't cached and needs its own system packages.
  `voxtype-mobile` is our own repo, so it could publish release binaries.
  termai would then download and checksum-verify them, the same way `scripts/install-test-herdr.mjs` already handles Herdr.
- Node version mismatch: everything is tested on Node 26.8.1, but releases bundle Node 22.23.3 (`build/release-config.json`).
  Only the final release job runs the installer on the Node that actually ships.
  Either align the versions or be aware that the earlier checks test a different Node.
- Small issues:
  - The `source` job uses inline Python, while everything else is Node.
  - It checks that the tag matches the version, which `package-release.mjs` checks again.
  - `publish` runs on `ubuntu-22.04` while every other job uses `24.04`.

### `performance.yml`: harmless, low value

- It's manual and gates nothing.
- Shared GitHub runners are too noisy for latency comparisons to be trusted, and the hard-coded baseline commit will go stale.
- Keep it if it's actually used; otherwise delete it.

### Supporting machinery that could go

- `scripts/ci-build.mjs` plus `test/ci-build.test.mjs` (~200 lines) build a manifest of file hashes and build details that every downstream job re-checks before using a build from earlier in the same run.
  Artifacts from one run are already tied to that run, so this mostly guards against misconfiguring the workflow itself.
  Once the job graph is simpler it isn't needed.
- The "Verify runner architecture" steps guard against GitHub mislabelling a runner, and `package-release.mjs` already checks the platform.
- `apt-get install build-essential cmake pkg-config` installs packages that come preinstalled on Ubuntu runners.
  Only `openssh-server` and `bash-completion` are really needed, which also saves the `apt-get update` time.
- `fetch-depth: 0` in the integration `build` job is unnecessary, since only the `changes` job needs full git history.

## Suggested shape

1. CI (every push and PR): `ci.yml` as it is, plus `cargo fmt --check` and the vocabulary check, with a target under 30 s.
2. Release (tag push):
   - One Linux x64 checking job runs Clippy, `cargo test`, `npm test`, installer tests, and optionally the browser tests.
   - Each platform builds, packages and smoke-tests.
   - One publish step creates the release with all files at once.
3. Delete `integration.yml`, the nightly cron, `rust.yml` as a separate workflow (fold what's kept into `release.yml`), `ci-suites.mjs`, `ci-build.mjs` and their tests, and the duplicate packaging steps.
4. Optionally keep `performance.yml` as manual only.

The only thing that needs action regardless of how CI is restructured is the release flow.
The other changes are about speed and maintenance, not correctness.
