# Building and publishing releases

The [Release workflow](../.github/workflows/release.yml) builds native Linux x86_64, Linux ARM64 and macOS Apple Silicon archives when a `v*` tag is pushed.
Pull requests and updates to `master` run the quick CI described in [ci.md](ci.md), and full local checks are required before committing or merging.
Manual release runs build and validate the same archives without publishing.
All Linux release checks and three native packages must pass before the publication job starts.
The publication job uploads every asset to a draft and publishes it only after confirming that all uploads are complete.
A failed build or upload never publishes an empty release or makes it Latest.
Tags with a prerelease suffix publish prereleases without making them Latest, while the installer selects stable releases by default.

Each archive includes the native Rust executable, frontend assets, launch and setup scripts, licenses and release metadata.
An official Node runtime and `ws` support installation and validation tools, while the installed service executes Rust directly.
Linux archives additionally include a pinned Voxtype Mobile CPU daemon and its upstream installer.
Linux builds use Ubuntu 24.04 because the pinned ONNX Runtime imports glibc C23 symbols missing from Ubuntu 22.04.
The supported Linux runtime baseline is glibc 2.39 or newer.
Herdr is downloaded only if requested during installation and is checked against the binary checksum pinned in the bundle.

## Release procedure

1. Merge the release workflow and installer into the default branch before publishing the first release.
2. Update the workspace version in `Cargo.toml` and the versions in `package.json` and `package-lock.json`, including the root package entry.
3. Commit the version change and push the commit you want to release.
4. Create and push a matching `vX.Y.Z` tag with `git tag vX.Y.Z` and `git push origin vX.Y.Z`.
5. Wait for the Release workflow to create the complete GitHub release before distributing the install command.

The tag must exactly match `v` followed by the package version, including any prerelease suffix.
The workflow checks out the tag and records its commit in every archive.
The publication job creates a draft with the three platform archives, individual `.sha256` files, `SHA256SUMS` and `install.sh`, then publishes the complete release.
Rerunning a failed publication replaces assets in its existing draft only after every target passes again.
If the tag was created by publishing an empty release in GitHub's UI, the publisher first moves that release back to draft and confirms its draft status before uploading.
Upload failures leave the recovered release in draft so publication can be retried safely.
The publisher refuses to overwrite any assets in an already public release, so use a new version for a subsequent release.
The one-liner requires the first complete stable release to exist, so adding these files alone does not make its download URL live.

## Validate before publishing

Use **Actions → Release → Run workflow** to build without creating or modifying a release.
Select the workflow branch and optionally supply a branch, tag or commit in the `ref` field.
Manual runs produce downloadable workflow artifacts and never execute the publication job.

One Linux x64 checking job runs Rust formatting, native Clippy, Rust and JavaScript tests, contracts, installer fixtures and all browser and native Herdr harnesses.
The release workflow and local validation use the same `npm run verify:local` command.
All full validation and packaging use the Node version pinned in `build/release-config.json`.
Each platform builds its frontend, then `release:package` compiles the optimized native executable once and creates the archive that both smoke checks exercise.
Formatting, lints and full browser validation run once on Linux rather than on every platform.
The platform jobs do not transport intermediate builds or generate build manifests.
Local performance checks remain available through the scripts and commit requirements described in [ci.md](ci.md).
The pinned Linux dictation daemon prepares alongside verification, and its cache depends on the companion source, runner, compiler and CPU build settings.
Voxtype Mobile currently has no published releases, so replacing its source build with checksum-verified downloads first requires upstream release binaries and per-platform pins.
The npm postinstall hook applies a version-scoped ssh2 Ed25519 key-generation fix and restores the execute permission on macOS node-pty helpers.
Keep the deterministic leading-zero key test and helper permission checks when updating those dependencies, and remove the compatibility fixes when stable upstream releases include them.
The packaged smoke check starts the bundled server, pairs a browser client and exercises a real PTY with Bash prompt hooks.
The installation smoke check uses a disposable home directory, installs without external integrations, and starts the installed launcher outside the release directory.
These checks do not install Tailscale, download speech models or modify the runner's real user services.
Linux jobs also execute the bundled Voxtype binary and check that its linked runtime libraries are available.
Dictation setup and Tailscale login use isolated fixtures in the installer suite, so a real tailnet and model inference still need a separate acceptance check when companion pins change.

## Dependency pins

Edit [build/release-config.json](../build/release-config.json) to change Node, the Voxtype Mobile source commit or the Herdr release and per-platform SHA-256 checksums.
Use a full Voxtype Mobile parent commit so its recursive submodule pins select the matching daemon protocol.
CI builds its `parakeet` feature with CPU inference and includes the upstream `scripts/install-daemon`, license and source provenance.
Keep the daemon's model, Opus framing and capabilities protocol compatible with libertty's dictation client when updating that pin.
The speech model is downloaded by the upstream installer only when the user opts into dictation setup.
libertty and Voxtype use the current stable Rust toolchain and their respective Cargo lockfiles.

## Local packaging

Use the Node version from `build/release-config.json` and install the platform's native dependency build tools.
Linux builds require a checkout of the pinned Voxtype Mobile parent repository with initialized submodules and a built `artifacts/voxtype-mobile-daemon`.
Point `VOXTYPE_MOBILE_CHECKOUT` to that checkout before packaging a distributable release.

```sh
npm ci
npm run verify:local
VOXTYPE_MOBILE_CHECKOUT=/path/to/pinned/voxtype-mobile npm run release:package
npm run verify:package -- release/libertty-v0.2.9-linux-x64.tar.gz
```

Packaging requires a clean checkout, the pinned Node version and a complete Linux companion bundle.
For local development checks only, `LIBERTTY_RELEASE_ALLOW_DIRTY=1` permits a different Node version, an uncommitted checkout or a Linux archive without the companion daemon.
That override is never used by release CI.
Local smoke checks create temporary application data and do not restart an existing libertty server.
