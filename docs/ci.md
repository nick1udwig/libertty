# CI checks

The [CI workflow](../.github/workflows/ci.yml) runs one independent `CI` job on pull requests and pushes to `master`.
The main CI target is 30 seconds or less from job start, with a 20-second limit on its check command.
It uses the runner's existing Node runtime and a shallow checkout without installing dependencies or restoring caches.
Only this `CI` check belongs on the required commit path.

## Main checks

`npm run ci:quick` checks JavaScript and TypeScript syntax, parses tracked JSON, verifies contract asset checksums and runs an explicit set of dependency-free unit tests.
These tests cover dictation state, reconnects, wire messages, input editing, plugins, Herdr space layout and other frontend logic.
The same command runs locally without `npm ci`, Rust or Chromium.
Any check failure or exceeded command budget fails CI.

```sh
npm run ci:quick
```

## Independent integration checks

The [Integration checks workflow](../.github/workflows/integration.yml) runs independently on pull requests, pushes to `master` and manual dispatch.
It runs Rust formatting and lints, all native and JavaScript tests, generated contract checks, installer fixtures and the frontend type check.
It builds the backend and frontend before running security tests, and development harnesses reuse the verified build.
It shares checksummed build archives with selected Linux browser jobs, which do not rebuild Rust or the frontend.
Main CI has no dependency on this workflow or its results.

[scripts/ci-suites.mjs](../scripts/ci-suites.mjs) selects Linux browser suites from the changed files.
Feature changes run suites for their affected consumers, while saved-data changes also run the compatibility harness.
Shared inputs, unknown paths or an unavailable comparison revision select all Linux integration suites and saved-data compatibility.
Deletions and both sides of renames contribute to selection, and pull requests use the merge base to exclude unrelated base-branch changes.

```sh
node --input-type=module -e 'import { selectSuites } from "./scripts/ci-suites.mjs"; console.log(selectSuites(["src/dictation.ts"]))'
```

To run a selected browser suite locally, build first and set the browser executable paths.
The native Herdr and dictation suites download and verify the pinned Herdr executable automatically.

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
These workflows do not block main CI, while published releases still require full validation before uploading assets.
See [releases.md](releases.md) for release pins, packaging and publication.

## Performance checks

The [Performance comparison workflow](../.github/workflows/performance.yml) is manual and independent of commit and release gates.
Select a platform and optionally a branch, tag or commit to compare with the historical architecture baseline.
The existing correctness and latency assertions still report failures within that workflow, and measurement artifacts remain available for investigation.
