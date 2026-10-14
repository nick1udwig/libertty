# Version bumps

Run the commands below from the repository root.
Use the requested version, or a patch increment when the request gives no version or release type.
Finish and commit the version bump before starting the next requested work item.

## Find every active occurrence

Record the current version before editing and search tracked files for that exact string.

```sh
old_version=$(node -p "require('./package.json').version")
git grep -nF -- "$old_version" -- . ':!archive/**'
```

This search includes lockfile dependency versions that may coincidentally match Termai's version, so inspect each match rather than replacing every occurrence.
Archived migration snapshots and third-party dependency versions are not application version fields.
The active fields and examples to update are:

| File | Location |
| --- | --- |
| `package.json` | Top-level `version` |
| `package-lock.json` | Top-level `version` and `packages[""].version` |
| `Cargo.toml` | `[workspace.package].version` |
| `Cargo.lock` | `version` in the `termai-engine` and `termai-server` package blocks |
| `docs/setup.md` | Explicit installer version and local archive example |
| `docs/releases.md` | Local archive verification example |

Both crate manifests inherit `version.workspace = true`, so they do not need separate version literals.
`build/release-config.json` pins Node, Herdr, and Voxtype Mobile rather than Termai's application version.
Release tags must match `v` plus the version in `package.json`.
Archive names and generated `release.json` metadata derive from `package.json`.
The Rust executable's `--version` and `/healthz` response derive from Cargo's package version.

## Update and verify

Replace `NEW_VERSION` below with the intended version.

```sh
npm version NEW_VERSION --no-git-tag-version
```

This updates the npm manifest and both root lockfile fields without creating a commit or tag.
Update the Cargo workspace version, the two local Cargo lockfile package entries, and the documentation examples listed above.
Inspect the npm and Cargo fields with:

```sh
npm pkg get version
node -p "JSON.stringify({lockfile: require('./package-lock.json').version, rootPackage: require('./package-lock.json').packages[''].version})"
rg -n -A 2 '^\[workspace\.package\]$|^name = "termai-(engine|server)"$' Cargo.toml Cargo.lock
cargo metadata --locked --offline --no-deps --format-version 1
git grep -nF -- "$old_version" -- . ':!archive/**'
git diff --check
git diff -- package.json package-lock.json Cargo.toml Cargo.lock docs/setup.md docs/releases.md
```

All application version fields must agree, and any remaining old-version matches must belong to unrelated dependencies or intentionally historical text.
Use the pinned Node version, run `npm ci`, and run `npm run verify:local` before committing version metadata changes.
Apply any additional validation required by AGENTS.md if the same item changes code or packaging.
Stage only the version bump files, preserving unrelated changes already in the checkout.
A version bump alone does not request deployment, a Git tag, a push, or release publication.
When publication is explicitly requested, follow `docs/releases.md` and use a tag that exactly matches `v` plus the package version.
