# Code review: improvement opportunities

I'd start with the Rust server, where most of the gains are.
It reads every client message and API request as untyped JSON and checks each field by hand.
That one pattern accounts for most of the largest functions, the copy-pasted helpers, and the input handling written twice for local terminals and Herdr panes.

## 1. Use typed Rust structs instead of raw JSON (biggest win)

Request bodies, WebSocket messages and Herdr replies are all `serde_json::Value`, checked one field at a time with calls like `message["x"].as_str().filter(...)`.
The largest functions are mostly this kind of checking:

- `session.rs:964` `receive`: about 350 lines matching on `message["type"]`.
- `herdr_view.rs:582` `receive`: about 470 lines doing the same.
- `herdr.rs:319` `action` (about 230 lines) and `herdr.rs:791` `normalize` (about 235 lines, built from `first(&[&pane["label"], …])` chains).
- The `/api/keychain` handler matches on `text(&input, "action")` the same way.

Defining the messages as serde types (an enum tagged by `type`, `action` enums, and structs for the Herdr snapshot) would do most of that checking automatically.
A few small wrapper types could carry the length limits, such as "string of at most N characters" or "safe integer".
These hand-written helpers would then go away:

- `integer` in `herdr_state.rs:10` and `herdr_view.rs:60`
- `safe_integer` in `herdr.rs:779` and `http.rs:214`
- `number` in `wire.rs:38`
- `control` / `controls` in `markers.rs:49`, `session.rs:1822` and `herdr_view.rs:65`
- 54 separate `encode_utf16().count() <= N` checks.

My rough estimate is that these handlers shrink by 40–50%.

`contracts/schemas.json` is already generated from the TypeScript protocol types.
In a test, you could check the Rust types against that file, so the frontend and backend can't quietly drift apart.

## 2. Replace the hand-written router in `http.rs`

`request()` at `http.rs:799` is about 700 lines of `if pathname == "/api/…" && *req.method() == Method::POST`.
`herdr_request()` at `http.rs:1507` adds another 250 lines of the same.
They repeat the same steps: read the body with `body(&mut req, 16384)`, look up the owner, build the session key.

The server already uses axum, so you could use its real `Router` with nested routes:

- Extractors would handle the owner, the session and the size-limited JSON body.
- One error type would turn failures into responses.
- Route groups could live in their own files (files, keychain, Herdr, SSH).

`tower-http` might also replace the hand-written security headers, CORS and gzip code (`http.rs:649` and `http.rs:737`).
You'd need to check it can keep the custom gzip threshold for constrained links.

One catch: `test/migration-contracts.test.mjs` finds routes by searching `http.rs` for `pathname == "…"`.
That test would need to read routes from a route table instead.

## 3. Input handling is written twice

`session.rs` (local and SSH terminals) and `herdr_view.rs` (Herdr panes) each have their own repair, repair-cancel, dictation start/finish/cancel, `start_repair`, prompt/revision guard, and the pair of dictation callbacks.
Compare `herdr_view.rs:855–960` with `session.rs:1041–1177`.

The two copies have already drifted:

- `session.rs` requires a dictation id that looks like a UUID; Herdr accepts any id up to 100 characters.
- The error messages differ.
- The session's status callback checks that the recording is still the current one, but the Herdr callback doesn't, which is worth checking for stale status messages.

One shared input controller, with hooks for "write text" and "check the line hasn't changed", would remove an estimated 250+ lines and stop the drift.

## 4. `src/main.ts` does too much

It's 1,061 lines but 94 KB, with 86 lines over 200 characters, often several statements per line.
In one file it handles:

- Loading and migrating saved state
- Authentication and the API client
- Tabs and the host menu
- SSH route probing
- The key vault screens
- Plugins and settings

Splitting it would help, for example into `api.ts`, `persistence.ts`, `tabs.ts`, `ssh-connect.ts`, `vault-ui.ts` and `settings.ts`.
Clear duplicates inside it:

- `consumePendingHerdr` and `consumePendingReading` (`main.ts:1024` and `:1041`) share the same find-or-create code for the backend and source tab.
- `openReading` and `openReadingCapture` (`main.ts:407` and `:413`) build tabs almost the same way.
- The host menu and tab menu (`main.ts:203` and `:245`) each have their own outside-click, resize and keyboard handling.
- The session-id regex, the capture-id regex and the path check are each repeated 3–5 times.
- There are three separate `button()` helpers (`main.ts:185`, `file-browser.ts:15`, `download-view.ts:10`), plus `node()` in `herdr-view.ts`.

A note on reducing line count: the TypeScript is already packed tight, so its line count understates its size.
Removing duplication is the real saving.
A formatter would add lines but make it easier to maintain.

## 5. One HTTP client for the frontend

About a dozen `fetch` calls each set their own `credentials`, `cache`, timeout, `Authorization`, the `X-Termai-Link` header and retry on 401.
They're in `main.ts`, `terminal.ts` (an `api` function plus two direct calls), `file-client.ts`, `plugin-file.ts`, `image-upload.ts`, `suggestion-client.ts`, `suggestion-worker.ts` and `reading-plugin.ts`.
One shared `request()` would make auth recovery and timeouts consistent.

## 6. The engine still emulates JavaScript regexes

`engine/src/util.rs:141` looks up regexes by pattern string at every call.
A `build.rs` (using the `syn` crate) scans the source to precompile them, with a runtime cache and translation of JavaScript's `\s` as a fallback.
Many of the 54 call sites are simple: `replace("qu", …)`, `test("^\\S", …)`, `test("(?i)^[a-z]$", …)`.
Static regexes, character checks or `str::replace` would let you delete `build.rs` and the `syn` dependency, which speeds up builds.
It would also drop the per-call lookup, which matters in the hot repair loop.

## 7. Leftovers from the Rust migration

`docs/rust-migration.md` says the TypeScript backend has been retired, but a lot of migration material is still in the repo:

- `docs/*-results.json`: about 26k lines of benchmark output.
- `output/imagegen/*.png` mockups and `initial-spec.md`.
- `scripts/migration-*.mjs`, plus the `typescript-reference` dev dependency (TypeScript 5.9, installed next to TypeScript 7).
- `contracts/regression-inventory.json`.
- `test/rust-state-compat.mjs`, which checks compatibility with state written by the old Node backend.

Keep the files that are still used: `engine-vocabulary.json` is compiled into the engine, and `schemas.json` and `assets.json` are used by tests.
The rest could be archived.

## 8. Shared setup for browser tests

Twenty browser and native test scripts each start the server, launch Chromium with their own flags, pair, and wait in loops.
They also use hard-coded ports (3123, 3167, 3178, …).
A shared helper in `test/support/` (start the server on any free port, launch the browser, pair) would cut roughly 15–30 lines per file and avoid port clashes.

## 9. Small efficiency items (low impact)

- In `session.rs:332–348`, each output chunk's `String` is copied into both the replay buffer and the pending queue, and a shared `Arc<str>` would avoid that.
- On each prompt, `history.push` can copy the whole 5,000-entry list if the engine still holds a snapshot of it, and then `remove(0)` shifts every entry.
- `herdr.rs` `normalize` runs nested linear searches (capped at 256 items).
- The cache eviction in `util.rs:103` re-adds all sizes on every pass of its loop.

None of these will matter until there's a lot of output or many Herdr panes.

## Suggested order

Do 1 and 3 together, since typed messages make the shared controller simple.
Then do 2, which builds on the typed bodies.
Then do 4 and 5.
Then do 6 and 7, which are mostly deleting code.
