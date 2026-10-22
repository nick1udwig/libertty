# CI checks

The [CI workflow](../.github/workflows/ci.yml) runs one `CI` job on pull requests and pushes to `master`.
The main CI target is 30 seconds or less from job start, with a 20-second limit on its JavaScript check command and a one-minute job timeout.
It uses the runner's existing Node and Rust tools and a shallow checkout without installing dependencies or restoring caches.
Only this `CI` check belongs on the required commit path.

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

[AGENTS.md](../AGENTS.md) routes agents to the [code changes skill](../.agents/skills/libertty-code-changes/SKILL.md) for required local validation before creating a commit or merging because ordinary pushes and pull requests only run fast CI.
Run the following with the Node version pinned in `build/release-config.json`, Rust with native dependency build tools, Chromium, OpenSSH server and Bash completion available.

```sh
npm ci
npx --no-install playwright-core install --with-deps chromium
npm run verify:local
```

[scripts/verify-local.mjs](../scripts/verify-local.mjs) runs fast checks, formatting, native Clippy, Rust tests, the complete build, JavaScript and contract tests, installer fixtures and browser checks in sequence.
[scripts/check-browser.mjs](../scripts/check-browser.mjs) contains the single explicit browser list used by both local validation and the Linux release checking job.
It covers native repairs, SSH, reading, Herdr, plugins, pairing, reconnects, gestures, touch, dictation, files and workspace behavior.
It first downloads and verifies the pinned Herdr release, which the dictation, spaces, resize, flash and fullscreen scrolling harnesses use as the real native integration.
It runs three harnesses at a time and reports every failure at the end; set `BROWSER_JOBS` to change the number.
Every existing application harness remains available through its original npm command or `node test/<harness>.mjs`.
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
One Linux x64 job runs `npm run verify:local`, and each supported platform then builds, packages and smoke-tests its actual shipped archive once.
There is no nightly schedule or separate integration or Rust workflow.
Manual runs create downloadable artifacts without publishing a release.
See [releases.md](releases.md) for pins, packaging and publication.

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
