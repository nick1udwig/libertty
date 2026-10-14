# termai reference

Implementation, testing, and deployment notes.
Start with the [README](../README.md) or the [usage guide](usage.md).

A mobile web terminal with inline dictation, command alternatives, and a real Bash session.
The MVP uses **Ghostty `0.4.0-next.20.g1858a59`**, pinned to the browser build selected in the performance comparison.

## Run locally

Source builds require Rust **1.89+**, the `wasm32-unknown-unknown` target, Node **22.18+**, a C/C++ build toolchain, Bash **4.4+**, Python 3 (for static Python argument discovery), and `base64`.
Developed and tested on Linux with Node 26 and Chromium.
The Rust server uses `portable-pty` for terminal processes and one shared engine crate for native and browser WebAssembly execution.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**.
The server opens a shell in the directory where it was launched.
Override that with `TERMAI_CWD=/path/to/project`.
It sources your `.bashrc` for aliases/functions, then installs its own prompt/history hooks and Emacs Readline bindings inside this session.
It does not edit your shell configuration or save new commands into your existing Bash history files.

Ctrl-R and arrow-key history search Bash's in-memory history, initially loaded from the host's `~/.bash_eternal_history` in both local and SSH terminals.
If that file is absent, Termai loads `~/.bash_history`.
Readline retains the latest 5,000 entries, including new commands from the current terminal.
`TERMAI_HISTORY_FILE` overrides the local source, followed by `TERMAI_ETERNAL_HISTORY_FILE`; explicit overrides do not fall back to another file.
Open a new terminal to load a changed source.

For the production PWA:

```sh
npm run build
npm start
```

The production build emits Ghostty WASM as a separate hashed asset and includes gzip/Brotli variants of JavaScript, CSS, and WASM.
The server negotiates these variants and streams asset bodies; HEAD requests only read metadata.
The pinned Ghostty packaging is checked during the build, so dependency updates must review the WASM transform.

The production build includes a manifest and service worker.
The service worker precaches the complete app shell, including JavaScript, fonts, and WASM, under a build-specific cache.
Activation removes older caches for this installation.
Hashed assets use cached responses first; navigation refreshes the single cached HTML entry.
The app shell can load offline after installation completes; running commands requires a connection to the host.
The development server does not register a service worker.
It pairs clients before proxying loopback Vite assets and checks both pairing and Origin before forwarding hot-reload WebSockets.

## Use it

The terminal is always the input view.
Tap it to use your keyboard or its dictation microphone.

- **Inline dictation:** the literal input appears in the real shell line with a spinner.
  When discovery finishes, the top interpretation replaces it.
  A floating menu shows up to three candidates and the unchanged literal text at the bottom.
  Tapping a row sends that command by default; **Enter** submits whatever is currently on the line.
  Disable **••• → Tap alternate to send** to make row selection only replace the line.
  Editing or submitting cancels pending suggestions.
- **Alternatives:** **••• → Open alternatives after dictation** controls whether the menu opens automatically.
  When disabled, a small dropdown beside the cursor reveals it.
  The menu flips above the cursor when space below is limited and does not take up terminal rows.
  Tapping elsewhere, pressing Escape, or choosing a row in replacement-only mode collapses the menu but keeps its dropdown available until the line is edited or submitted.
  Both preferences are saved in this browser.
- **Shortcuts:** the bottom row starts with Ctrl-R, Tab, Esc, a Ctrl modifier, arrows, and Ctrl-C.
  Use **••• → Customize shortcuts** to add, edit, remove, or reorder buttons.
  Each button sends keys or runs a saved shell command.
  Command buttons require an idle prompt; keys also work in interactive programs.
- **Automatic context:** available command names are collected at shell startup and each prompt, including aliases/functions.
  Internal underscore-prefixed shell functions such as `_git_init` are excluded from inferred commands unless explicitly named.
  Directory files refresh after shell commands or filesystem changes.
  The selected command’s flags are discovered in the background.

For a local script declaring `argparse.add_argument('--myarg')`, a transcript such as:

```text
Python three hello world dot py hep hep myarg food
```

can produce:

```sh
python3 hello_world.py --myarg food
```

`HelloWorld.py`, `hello-world.py`, and “hello world dot py” are matched against actual files.
Multiple existing matches stay available as alternatives.
The unrestricted value `food` remains unchanged.
Typed flag case, quoted values, shell operators and substitutions are preserved.
The supplied Urbit symbol names are recognized in dictation, including `hep`/`shed` for `-`/`--`, `fas` for `/`, `buc` for `$`, and the quote, bracket, operator and compound names.
Explicitly spoken shell syntax retains its meaning and the original transcript remains available.
Words already enclosed in literal quotes are not translated.
General English names (including multiword names such as “forward slash”, “dollar sign”, “double dash”, and “open square bracket”) also generate symbol alternatives.
Nearby spellings, transposed letters, and similar pronunciations are considered against the same vocabulary, with up to three alternative interpretations.
Short names require exact matches, executable names are preserved, and filename-like tokens are not split to look for symbol words.
Interpretations pass through the shared command/path checks; complex shell syntax is checked without executing it.
The original transcript stays available as its own choice.

Command spelling also uses the actual executable catalog: “L S” and “ell ess” can suggest `ls`, “sea pea” can suggest `cp`, and “pee double you dee” can suggest `pwd`.
For short alphabetic command names, generated letter pronunciations also match nearby fused words such as “Alice” or “Ellis” for `ls`.
These are general English letter rules, with sound and length checks, rather than command-specific aliases.
Exact executable names take precedence, quoted text and free-form arguments are preserved, and the original transcript remains available.

## What runs where

Both execution modes use the same [shared repair library](shared-engine.md).
By default (`TERMAI_ENGINE=server`), `/api/suggest` runs the engine on the host with direct filesystem and subprocess access.
With `TERMAI_ENGINE=client`, a dedicated browser worker runs that engine and obtains bounded host facts through `/api/facts`.
The WebSocket handshake announces the mode without an additional request.
SSH sessions use the browser engine through a remote facts adapter; see [workspace architecture](workspace.md).

The browser uses Ghostty’s native terminal input textarea for dictation, a Ghostty canvas for terminal output, and a direct WebSocket connection.
Output bypasses UI state and is drained in bounded animation-frame batches.
The server pauses PTY reads when unacknowledged output reaches its window limit.

The host supplies a catalog from the actual shell's `compgen` output, current-directory entries (up to 10,000, with immediate entries prioritized) plus one level of nearby files within a 4,000-path budget, and up to 5,000 history entries from `.bash_history`, `.bash_eternal_history`, the live shell’s configured `HISTFILE`, and this terminal session.
History readers take bounded tails of large files and refresh in the background.
`TERMAI_HISTORY_FILE` overrides the default sources; `TERMAI_ETERNAL_HISTORY_FILE` adds an explicit eternal-history source.
Commands observed in this session also carry working-directory context for ranking.
Deterministic matching handles spoken punctuation, a small set of number pronunciations, simple English phonetic similarity, edit distance, and history ranking.
Filename repair is scoped to known file-taking command positions; arbitrary text arguments are preserved.
Common flag schemas are included, with Git flags scoped to supported subcommands.
Git supplies its installed command and alias names through its read-only command listing.
Simple aliases such as `c = commit` reuse the target builtin’s flags; shell aliases and multiword alias bodies are never executed for discovery.
Multiword speech such as “get in it” can match `git init` without being collapsed into an underscore-separated function name.
Discovery searches likely executable names independently of whether the rest of the transcript already parses.
It reads the root command’s help, matches spoken words against the returned subcommands, and follows matching child help routes before reparsing with the newly learned schemas.
This handles previously unseen commands and nested subcommands, including multiword speech, inherited global flags, Cobra/Clap command tables, argparse command choices, and usage-based command listings such as Git worktrees.
The search follows at most three subcommand levels and two branches per level, with a seven-probe cap per root and a deadline for starting further levels.
Only parent-advertised command names and help flags reach a probe; transcript argument values do not.
Cached discovery is reused across requests.
Commands with unusual or unavailable help remain limited to available context and the literal transcript.
Python `argparse` and Click declarations are inspected using Python's AST without importing or executing the script.
Other executables are resolved through the live shell’s exported PATH and environment.
The selected executable’s help is queried in the background, and recognized subcommands get their own flag schemas.
Requests are deduplicated and cached per session, directory, executable version and environment for ten minutes.
All sessions share a budget of two concurrent subprocesses across help discovery, Python inspection, and Bash syntax validation, with at most 64 queued subprocesses.
Help probes are each limited to 1.5 seconds and 128 KiB.
Suggestion requests have a five-second deadline, including queued work.
Disconnected requests release their subscriptions; shared probes continue only while another request still needs them.
Only the executable, a recognized subcommand and a help flag are passed to the probe; the user’s argument values are never executed for discovery.
Catalog entries are not bulk-executed.
Aliases and functions participate in name matching; custom function grammars and complex alias bodies are not inspected.
Dynamic script definitions and unrestricted value correction remain unresolved rather than being invented.

Dictation first checks indexed history, then common and already-cached command schemas.
A strong candidate that passes validation returns immediately without a help search.
Directory repair remains a bounded filesystem lookup.
Only when these methods fail does parsing expand referenced paths and search live help.
History matching preserves explicit flags and quoted values: `-m "add init commit"` cannot match a historical `. m` or a different message.
Bash syntax results are also cached, while file existence is still checked against the current filesystem.

History and matching indexes, discovery traversal and learned schemas live with the engine, on the server or in the browser worker.
Metadata is learned on demand and cached for ten minutes, scoped to directory and an opaque exported-environment identity.
Server mode prewarms command metadata at prompts using a lightweight catalog.
Client mode leaves command-help prewarming disabled; while the connected shell is at a prompt, lightweight context is pushed every two seconds with changed catalog fields and bounded prefetching of small cwd/home listings.
Browser directory snapshots are verified in the final fact batch before a repair is accepted; changed directories trigger a bounded retry.
Reloading the page loses worker caches, while native process-result caches remain on the server.
New commands still work through live discovery when needed.

When ordinary matching has no strong result, compact dictation such as `LSL` is split at each possible character boundary, retaining only real command names and known flags (for example, `ls -l` and `ls -L`).
Existing executable names take precedence, and unknown suffixes do not become invented flags.
Missing command/option spaces are recovered only at command names that actually exist: `LS-L` can become `ls -l`, while an installed executable named `ls-l` is preserved.
For an all-uppercase command name or a missing command/flag boundary such as `ls-L`, matching lowercase flags rank ahead of their uppercase counterparts.
Both cases stay available whenever they are known options, regardless of command capitalization.
A correctly cased `ls -L` stays `ls -L`.
Flags are checked against known schemas and discovered help, including short-option bundles and attached values.
Unknown options and incomplete value-taking options remain literal instead of being presented as parsed alternatives.
Literal fallback rows are shown once, separately from repairs.
Full-command history matches can supply candidates and improve ranking, but must pass the same checks as generated candidates.
Distant guesses are omitted instead of padding the menu to three rows.
Explicitly referenced directories also supply real filenames beyond the current-directory catalog.

Before displaying a generated candidate, Bash parses it with `--noprofile --norc -n` in a clean environment.
This syntax check does not execute the command, substitutions, or redirections.
Simple commands also undergo command-name, known subcommand, flag/value, clear required-operand, and applicable input-file/directory checks.
A proposed `git init` is never run to validate it.
Complex shell expressions receive syntax checking only; custom command semantics, aliases/functions, runtime permissions, network state and program-specific preconditions cannot be proven without execution.
The untouched transcript remains available for deliberate use even if it fails these checks.
There is no universal side-effect-free dry-run mode for arbitrary commands.

`cd` and `pushd` path repair reads actual directories component by component, starting at the current directory, `/`, or the live shell's home directory for `~`.
It follows directory symlinks and matches spoken words against each level's real names: `Cd ~/get/pebble agent` can resolve to `cd ~/git/pebble-agent`.
Exact existing components take precedence; files are excluded from directory candidates, spaces are quoted correctly, and failed lookups leave the literal input available.
Each request bounds traversal depth, branching and directory reads.
This path walk does not execute commands or scan unrelated directory trees.
Case-only command matching takes precedence over punctuation normalization, so `Cd` does not become the `_cd` completion function.

If the final path component has no spelling or pronunciation match, its last word or phrase can complete a prefix of an existing name.
Spaces, case, hyphens, and underscores use the same normalization as ordinary name repair, with at least three normalized characters required.
For example, `CD toldo slash git slash branch point slash branch po` can suggest `cd ~/git/branchpoint/branchpoint` when that directory exists: the general symbol pronunciation rules recognize “toldo” as “tilde,” and the clipped final phrase completes “branchpoint.” This fallback also applies to known filename positions and the final input file component for `cat` and `download`.
Exact names and ordinary spelling matches win, intermediate components and quoted spellings are not completed, and multiple matches stay available alongside the original transcript.
Download output names remain literal.

Command catalogs refresh when PATH, working directory, alias/function names, or PATH-directory timestamps change, with a two-second fallback.
Environment and command files retain parsed snapshots when unchanged.
Directory enumeration stops at its entry budgets, and cataloged directory timestamps are checked at new prompts so nearby file changes remain visible.
The host reuses unchanged history source-file tails; the worker retains parsed indexes for unchanged catalog arrays.
Matching indexes retain normalized names and phonetic forms for each immutable catalog snapshot.

Catalogs and metadata are cached in memory.
Command repair uses no AI service, persistent correction database or global filesystem index.
Bash completions and optional Voxtype Mobile dictation are described in the [usage guide](usage.md#dictation).

Directory repair now tries complete exact paths first, filters regular files before fuzzy ranking, and reuses prepared directory-name indexes.
Host listings have bounded caches with metadata checks and filesystem-watch invalidation.
Directory requests skip unrelated general path collection, and independent branches and validation checks run concurrently.
See [the optimization report](directory-optimizations.md) for limits, tests and measurements.

## Sessions and reconnects

Shell state and the current directory come from private shell integration records.
Inline replacements edit Bash Readline without sending Enter.
Each replacement checks both the prompt and the input revision, so a late reply cannot overwrite later keystrokes or enter a running program.
Saved command shortcuts also require an idle prompt.
Raw terminal input remains available while a program is running.

The server keeps a session alive for up to **one hour after disconnection**.
Backgrounding the app releases the output connection so a hidden browser's paused animation frames do not block shell output.
Reconnecting to the same running server retains the shell and replays unseen output.
Reloads can replay up to the last **2 MiB**, also bounded to 16,384 output chunks to limit small-chunk overhead.
This bounded raw replay is not a complete VT snapshot: after truncation, interactive programs may need Ctrl-L or another redraw.
The UI calls out truncation.

Commands have request IDs to suppress duplicate delivery within a bounded recent-request cache.
Unacknowledged commands and raw keystrokes are **never automatically resent**.
A server restart loses live sessions and in-memory metadata/history.
One browser tab controls a given session at a time.

## Connect from a phone

Loopback access is the default.
For a phone, put the production server behind a trusted HTTPS connection or tunnel.
HTTPS is needed for normal PWA installation and browser capabilities on remote hosts.

For example, with an existing HTTPS reverse proxy on the same machine:

```sh
TERMAI_TOKEN='a-long-random-token-of-at-least-24-characters' \
TERMAI_ALLOWED_HOSTS='termai.example.com' \
npm start
```

Point the proxy at `127.0.0.1:3000`, preserve the `Host` header, and forward WebSocket upgrades.
Enter the token in the app's connection screen.
For a direct LAN binding, additionally set `HOST=0.0.0.0`; the server requires explicit allowed hostnames for non-loopback bindings.
Pairing is required for all bindings, including localhost.
If `TERMAI_TOKEN` is unset or empty, a random token is saved to `$TERMAI_DATA_DIR/pairing-token` (default `~/.local/share/termai/pairing-token`) and printed at startup.
`TERMAI_ALLOWED_HOSTS` is a comma-separated list of hostnames/IPs without schemes or ports.

The shell runs with your user privileges.
The server validates Host and Origin, uses an HttpOnly SameSite session cookie, and requires the pairing token before granting access to any local or remote session.
It is a single-user MVP, without multi-user isolation or an internet-facing account/authentication system.

## Existing local deployment (machine-specific)

The app runs as the enabled user service `termai.service` on **127.0.0.1:7321**.
Open **https://omafwchy.taila510b.ts.net/t/** from a device on the tailnet.
Tailscale Serve forwards only `/t` to this app; existing routes stay separate.

```sh
systemctl --user status termai
systemctl --user restart termai
journalctl --user -u termai -f
```

The service uses `TERMAI_BASE_PATH=/t` and explicitly allows the tailnet hostname.
Assets, API requests, WebSockets, cookies, the manifest and service worker are scoped to `/t/`.
This route requires the pairing token as well as tailnet access.
Read the token in the service’s startup journal.
To rebuild changes, run `npm run build` and restart the service.

For another subpath deployment, set `TERMAI_BASE_PATH` at runtime and use a reverse proxy that preserves the Host header.
Both prefix-preserving and prefix-stripping proxies are supported.
Tailscale Serve strips its mount prefix.

## Verify

```sh
npm test
npm run test:rust
npm run build
TEST_ENGINE=server npm run test:browser
TEST_ENGINE=client TEST_BASE_PATH=/terminal npm run test:browser
npm run test:reconnect
```

The reconnect test covers stalled authorization and Herdr ticket requests, delayed close events, stale open sockets, and recovery without replaying input.
The browser test uses `/usr/bin/chromium` (override with `CHROMIUM=/path/to/chromium`), a loopback server, temporary fixture files and isolated Bash sessions.
It covers loading and ready alternatives, real Readline replacement, default tap-to-send with duplicate-tap protection, replacement-only selection, reopenable collapsed menus and saved preferences, incremental mobile composition and ordinary typing, mobile Backspace after dictation and during pending repair, case alternatives, spoken symbols, home-relative directory resolution, completion-helper exclusion, eternal-history context, non-executing validation, late-response cancellation, composition-event deduplication, cached help discovery, Git alias flags and explicit `-m` preservation despite corrupt history, Python inspection, command shortcuts, Ctrl-R, busy guards, current-directory updates, mobile and keyboard-sized layouts, reconnect/offline behavior, authentication, command deduplication, stale edit rejection, and output acknowledgements.
Screenshots are saved to `.test-artifacts/`.
The README uses full mobile viewport captures, including the terminal, alternatives menus, and shortcut bar, from three simulated dictation regressions.
To refresh those images after running `npm run build` and `npm run test:browser`:

```sh
mkdir -p docs/images
cp .test-artifacts/example-{git-init,ls,python}.png docs/images/
```

These fixtures verify termai’s text repair; they do not record audio or benchmark Aqua Voice, Wispr Flow, or a phone keyboard.

Actual Android/iOS dictation, IMEs, touch selection and software-keyboard behavior still need device testing.
Browsers do not expose one universal dictation event: the app recognizes multi-character insertions, replacement text and bulk committed compositions; clipboard paste stays raw.
Incremental mobile keyboard compositions stream into the terminal as they change, including deletion and correction, rather than going through dictation repair.
The hidden keyboard textarea retains a non-output sentinel so mobile keyboards can issue Backspace after text was inserted directly into Bash.
Bulk keyboard suggestions and speech may still look identical to the browser.
Completion, history navigation, and unrecognized editing sequences suspend automatic repair until the next prompt because the browser no longer knows the exact editable line.
Reconnecting to a partially typed line also leaves it untouched.
Automated keyboard-size tests simulate viewport changes; they do not emulate an OS keyboard.
Linux/Bash is the implemented host target.

The original product conversation is preserved in [initial-spec.md](../archive/migration/README.md); the user's desires take precedence over its assistant recommendations.
The complete benchmark project was moved to **`~/git/termai-benchmark`** before MVP work began; see its `terminal-comparison.md` for the engine decision.
