# CI checks

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests and pushes to `master`.
It cancels superseded runs for the same pull request or branch.
The final `CI` check requires the default checks and every selected integration job to pass.

## Default checks

One Linux x86_64 job runs Rust formatting and lints, Rust and JavaScript tests, generated contract checks, installer fixtures and the frontend type check.
It builds the debug backend, release WebAssembly and frontend once, then checks browser pairing with a real terminal and the actual browser WebAssembly boundary.
It shares a checksummed build archive with the selected browser jobs, which do not rebuild Rust or the frontend.
Documentation and unit-test-only changes finish with these default checks.

## Relevant integration checks

[scripts/ci-suites.mjs](../scripts/ci-suites.mjs) selects Linux browser suites from the changed files.
Feature changes run the suites for their affected consumers, and browser harness changes run their own suite.
Saved-data changes also run the compatibility and rollback harness.
Shared inputs, unknown paths or an unavailable comparison revision select all Linux integration suites and saved-data compatibility.
Deletions and both sides of renames contribute to selection, and pull requests use the merge base to exclude unrelated base-branch changes.
Pairing and WebAssembly are already covered by the default job, while performance harness changes remain outside integration selection.

To inspect a selection locally, pass a file list to the exported selector.

```sh
node --input-type=module -e 'import { selectSuites } from "./scripts/ci-suites.mjs"; console.log(selectSuites(["src/dictation.ts"]))'
```

To run one selected browser suite after building locally, use its name.
The native Herdr and dictation suites download and verify the pinned Herdr executable automatically.
Set `CHROME_PATH` and `CHROMIUM` to the installed Playwright Chromium executable before running browser harnesses.

```sh
npm run build
npm run build:test-support
npx --no-install playwright-core install --with-deps chromium
export CHROME_PATH="$(node -e 'process.stdout.write(require("playwright-core").chromium.executablePath())')"
export CHROMIUM="$CHROME_PATH"
node scripts/ci-suites.mjs dictation
```

## Full platform and release checks

The [Release workflow](../.github/workflows/release.yml) runs full validation daily at 08:17 UTC, on published releases and on manual dispatch.
These runs cover Linux x86_64, Linux ARM64 and macOS Apple Silicon, including the complete browser matrix, saved-data compatibility, packaged executables, installation and the pinned Linux dictation daemon.
Scheduled and manual runs create downloadable archives, and only published releases upload release assets.
The [Full platform validation workflow](../.github/workflows/rust.yml) can also be dispatched manually when platform coverage is needed without producing the complete release bundle.
See [releases.md](releases.md) for release pins, packaging and publication.

## Performance checks

The [Performance comparison workflow](../.github/workflows/performance.yml) is manual and independent of commit and release gates.
Select a platform and optionally a branch, tag or commit to compare with the historical architecture baseline.
The existing correctness and latency assertions still report failures within that workflow, and measurement artifacts remain available for investigation.
Timing measurements on shared runners need more consistent evidence before they can become required checks again.
