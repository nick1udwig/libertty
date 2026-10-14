# Repository instructions

Write all prose with one and only one sentence per line, including Markdown, comments, commit bodies, and user-facing text.
When a request contains multiple work items, complete them one at a time in the requested order.
For each item, implement it, test it, fix any bugs and rerun the affected checks, then commit it before moving to the next item.
Keep unrelated existing changes out of each item's commit.

## Repository skills

Read [.agents/skills/termai-ops/SKILL.md](.agents/skills/termai-ops/SKILL.md) for local deployment, systemd and Tailscale operations, version bumps, and release packaging.
The ops skill's [version bump reference](.agents/skills/termai-ops/references/version-bumps.md) lists every active version field and the commands to find and verify them.

## Validation before committing or merging

Run `npm run ci:quick`, `cargo fmt --all -- --check` and `npm run contracts:vocabulary -- --check` before creating a commit or merging.
For changes to application code, dependencies, contracts, build scripts or workflows, also run `npm run verify:local` before creating a commit or merging.
Use the Node version pinned in `build/release-config.json` and install dependencies with `npm ci` before full validation.
The full script checks Rust lints and tests, builds the application, runs JavaScript and installer tests, verifies saved-data compatibility and executes every browser and native Herdr harness once.
Install Chromium with `npx --no-install playwright-core install --with-deps chromium` when a browser is unavailable, and provide `CHROME_PATH` and `CHROMIUM` for a custom executable.
Linux validation also needs `openssh-server`, Bash completion and a usable SSH daemon runtime directory.
The browser script downloads and checksum-verifies the pinned Herdr binary into `.test-artifacts/bin`.

For changes to wire encoding, compression, terminal streaming or rendering, run `npm run verify:performance` before creating a commit or merging.
For changes to the suggestion engine, discovery, fact fetching or directory caches, also run `BENCH_SUITE=shared npm run bench:architecture` before creating a commit or merging.
For changes to workspace startup or input latency, also run `npm run bench:workspace` before creating a commit or merging.
These standalone benchmarks retain their correctness assertions, latency budgets and reports in `.test-artifacts`, and the architecture and workspace commands use historical TypeScript references described in `docs/ci.md`.
If packaging, launchers or installation change, build a local archive with `TERMAI_RELEASE_ALLOW_DIRTY=1 npm run release:package` and run `npm run verify:package -- release/termai-vVERSION-PLATFORM.tar.gz` before creating a commit or merging.
The package script runs both smoke checks and browser checks in both engine modes against the extracted archive.
Report any failing or unavailable required check explicitly and do not claim it passed.
