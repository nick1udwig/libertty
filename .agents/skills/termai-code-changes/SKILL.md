---
name: termai-code-changes
description: Make and validate Termai application or build changes, and select the required checks before any repository commit or merge.
---

# Termai code changes

Follow the writing rules and item-by-item implementation, testing, bug fixing, and commit order in [AGENTS.md](../../../AGENTS.md).
Run commands from the repository root and select validation from the actual changes in the current item.

## Find the implementation

The browser frontend is TypeScript in `src/`, the native backend is Rust in `crates/server/`, and the shared native engine is Rust in `crates/engine/`.
Wire and API contracts and asset checksums live in `contracts/`, and `scripts/engine-vocabulary.mjs` maintains the canonical command and speech vocabulary.
Read [docs/client-architecture.md](../../../docs/client-architecture.md) for frontend changes, [docs/shared-engine.md](../../../docs/shared-engine.md) for engine changes, and [docs/workspace.md](../../../docs/workspace.md) for workspace changes.
Use [docs/ci.md](../../../docs/ci.md) for harness details and historical benchmark references.
Use [the ops skill](../termai-ops/SKILL.md) for deployment, version bumps, and release procedures.

## Validation before committing or merging

Run `npm run ci:quick`, `cargo fmt --all -- --check` and `npm run contracts:vocabulary -- --check` before creating a commit or merging.
For changes to application code, version metadata, dependencies, contracts, build scripts or workflows, also run `npm run verify:local` before creating a commit or merging.
Use the Node version pinned in `build/release-config.json` and install dependencies with `npm ci` before full validation.
The full script checks Rust lints and tests, builds the application, runs JavaScript and installer tests, verifies saved-data compatibility and executes every browser and native Herdr harness once.
Install Chromium with `npx --no-install playwright-core install --with-deps chromium` when a browser is unavailable, and provide `CHROME_PATH` and `CHROMIUM` for a custom executable.
Linux validation also needs `openssh-server`, Bash completion and a usable SSH daemon runtime directory.
The browser script downloads and checksum-verifies the pinned Herdr binary into `.test-artifacts/bin`.

For changes to wire encoding, compression, terminal streaming or rendering, run `npm run verify:performance` before creating a commit or merging.
For changes to the suggestion engine, discovery, fact fetching or directory caches, also run `BENCH_SUITE=shared npm run bench:architecture` before creating a commit or merging.
For changes to workspace startup or input latency, also run `npm run bench:workspace` before creating a commit or merging.
These standalone benchmarks retain their correctness assertions, latency budgets and reports in `.test-artifacts`, and the architecture and workspace commands use historical TypeScript references described in [docs/ci.md](../../../docs/ci.md).
If packaging, launchers or installation change, build a local archive with `TERMAI_RELEASE_ALLOW_DIRTY=1 npm run release:package` and run `npm run verify:package -- release/termai-vVERSION-PLATFORM.tar.gz` before creating a commit or merging.
The package verification script runs both smoke checks and the browser suite against the extracted archive.
Report any failing or unavailable required check explicitly and do not claim it passed.
