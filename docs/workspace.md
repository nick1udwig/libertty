# Terminal workspace

The `feature/hosts-tabs-ssh` branch adds a terminal-first workspace, saved direct and SSH hosts, backend selection, and a browser keychain with optional backend backups.
It builds on the single repair library at `2a99127`; master and the former experiment branch are unchanged.

## Runtime boundaries

`src/main.ts` manages the workspace and saved profiles.
Each terminal uses a same-origin `terminal.html` frame running the existing renderer and input pipeline.
Frames stay mounted when switching tabs; background output continues draining so flow control cannot stall a hidden terminal.
The tab header supplies new-tab and back controls.
Connection actions and terminal/file/Herdr tab lifecycles now register through the [runtime plugin registry](plugins.md).
User packages load from Settings into isolated frames with a scoped file-read bridge; the built-ins retain their existing trusted views.
Settings has its own pane in the bottom navigation and applies preferences to open terminals.
Default font size is 10 pt (13⅓ CSS px).

Each frame connects directly to its chosen backend.
Origin/source-checked messages supply access credentials; iframe URLs contain a backend URL and session ID, never tokens or passphrases.
Cross-origin backends require an explicit frontend origin allowlist.
HTTP uses bearer access tokens; cross-origin WebSockets use short-lived, single-use, session-bound tickets.
Sessions belong to the authenticated browser owner.
The primary backend is the one serving the workspace.

Every backend requires a pairing token before issuing browser credentials, including the primary backend and localhost.
The server prints its token at startup and saves generated tokens in `TERMAI_DATA_DIR/pairing-token` with mode 0600.
`TERMAI_TOKEN` can override it with at least 24 characters.
Pairing survives browser and server restarts.
The browser saves an issued credential per backend URL in local storage, and the backend saves only credential hashes in `paired-clients.json` (mode 0600).
The HttpOnly session cookie is persistent and renewed on reconnect.
Changing the pairing token revokes saved credentials.

Native sessions retain the existing server/client engine selection and transport.
SSH sessions use the browser worker and shared repair library with `SSHHost` as the remote facts adapter: SFTP directory data, shell context, syntax checks, verified help routes and static Python inspection.
Terminal output and fact channels share one SSH connection.
No termai daemon is installed on the SSH target.
SSH needs a POSIX environment with Bash, SFTP, `mktemp` and `base64`.
Remote Python inspection additionally needs Python 3.
Keyboard-interactive/MFA, forwarding, agent forwarding and remote Windows shells are not implemented.
SSH help probing is more conservative than native probing; Git alias discovery is not yet mirrored.

Automatic routes measure two complete browser→backend→SSH TCP-connect probe requests per candidate and choose the lowest mean, cached for 60 seconds.
This is a latency estimate, not a throughput measurement.
Only already-connected backends are eligible.
Browser keys and account passwords can use any candidate; backend-only keys require a matching public fingerprint.
The chosen backend is shown before passphrase entry.
Keys are only saved on other backends by explicit backup, and live sessions are not migrated.
Fixed routing remains available.

## Storage and trust

Hosts and tab references use browser local storage; backend access tokens use local storage.
Passwords and passphrases are cleared from forms and never saved.
Live terminals survive reloads and disconnects while the backend remains alive; backend restart ends them.
Clearing browser storage loses saved profiles.
There is no cross-device profile synchronization in this implementation.

The canonical key vault is **This browser**: IndexedDB database `termai-keychain`, object store `keys`.
Ed25519 keys are generated with Web Crypto and packaged in OpenSSH format.
Private material is encrypted with AES-256-GCM, random salt and nonce, and PBKDF2-SHA256 (600,000 iterations).
Authentication data binds the format, version, public key and fingerprint to the ciphertext.
Passphrases are required; there is no arbitrary length rule.
Names, fingerprints and backup destinations are readable metadata.
Persistent storage is requested where supported, but clearing site data still deletes local keys.
Browser generation needs Web Crypto Ed25519 support and a secure context (HTTPS or localhost).

Key details offer a one-click encrypted JSON export.
Importing this file in another browser validates the format and passphrase before saving, with a new local ID and no inherited device-backup references.
It works without contacting a backend.
Private SSH export requires unlocking; generated keys are unencrypted in this format.
Raw SSH imports are validated transiently by the primary backend before local encryption.
Encrypted SSH imports use their existing passphrase.

**Back up to devices** copies a local key only to checked saved backends.
Repeating it updates the same backup identity.
The local key remains canonical; backups are manual snapshots, and local renames/deletions do not propagate.
Use encrypted-file export/import for another browser without its own backend.
Existing backend keys can be explicitly restored into the browser.
There is no automatic migration or synchronization.

Backend copies use `$TERMAI_DATA_DIR/vault.json` (default `~/.local/share/termai/vault.json`), AES-256-GCM and scrypt, with atomic mode-0600 writes in a mode-0700 directory.
Exporting a backend copy requires authenticated backend access and its correct key passphrase.
The backend vault is shared by trusted users of that backend, not isolated per browser owner.
Run one backend process per data directory.

Browser keys are unlocked locally and passed to the chosen gateway for SSH connection, never persisted in its vault unless explicitly backed up.
The gateway is trusted with private authentication material in memory; this is not an SSH agent protocol.
Backend access already grants shell access as its operating-system user.
Use HTTPS over the network.
Passphrases are not saved.
JavaScript strings cannot be reliably erased; byte buffers are cleared where possible.

Format references: [Web Crypto key generation](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/generateKey), [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), and [OpenSSH private-key format](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key).

First-use SSH fingerprints require confirmation; changed pinned keys are rejected until explicitly forgotten.
Pins belong to the backend vault.

## Validation

- Production build and 83 unit tests pass.
- Existing native and browser-engine suites pass, including mounted `/t`, Readline repair, stale responses, reconnects, origin checks and large output flow control.
- `npm run test:workspace` starts two backends and a real disposable OpenSSH daemon.
  It verifies terminal-first launch, 10 pt, separate persistent tabs, background output, direct backend authentication, encrypted IndexedDB persistence, offline export/restore, unlocked SSH-file export, selected-device backups, backend restore, transient browser-key SSH, eligible route selection, SSH fingerprints, remote directory/Python repair, SSH restoration, session ownership, CORS, single-use tickets and changed-key rejection.
- The offline-cache test verifies separate workspace and terminal navigation entries.
  The workspace browser test saves screenshots in `.test-artifacts/`.

The workspace test needs local Chromium and OpenSSH `sshd` (default locations `/usr/bin/chromium` and `/usr/bin/sshd`), and free ports 3153/3154/3158.
It uses temporary authorized keys and host keys, never the user's SSH configuration.

## Repair performance

The before revision is `2a99127`, which already contains the shared library.
The after measurements use the working tree.
Both native and browser repair preserve all candidate arrays and cold/warm foreground request counts across **7,992** comparisons.
The library's repair algorithms have not changed.

Pooled local warm medians, milliseconds, 202 samples per cell from opposite-order runs:

| Case | Native before | Native workspace | Browser before | Browser workspace |
| --- | ---: | ---: | ---: | ---: |
| history | 0.33 | 0.34 | 0.97 | 0.93 |
| schema | 0.80 | 0.77 | 1.22 | 1.25 |
| flags | 0.72 | 0.75 | 1.22 | 1.16 |
| python | 3.23 | 3.29 | 3.87 | 4.00 |
| nested help | 0.65 | 0.66 | 0.94 | 0.91 |
| directory | 0.31 | 0.32 | 0.29 | 0.30 |
| exact directory | 0.20 | 0.20 | 0.24 | 0.25 |
| large directory | 0.29 | 0.29 | 0.38 | 0.41 |
| referenced file | 8.14 | 8.27 | 8.87 | 9.02 |

Warm medians at 150 ms simulated RTT, milliseconds, five samples per cell:

| Case | Native before | Native workspace | Browser before | Browser workspace |
| --- | ---: | ---: | ---: | ---: |
| history | 151.04 | 150.92 | 151.72 | 152.08 |
| schema | 151.57 | 151.69 | 152.20 | 152.54 |
| flags | 151.33 | 151.36 | 151.99 | 152.64 |
| python | 154.08 | 154.71 | 456.63 | 456.32 |
| nested help | 151.24 | 151.32 | 152.10 | 152.00 |
| directory | 151.65 | 151.79 | 151.05 | 150.85 |
| exact directory | 151.22 | 151.12 | 151.24 | 151.16 |
| large directory | 151.13 | 151.65 | 151.36 | 151.38 |
| referenced file | 158.12 | 158.91 | 762.72 | 761.62 |

The largest pooled local median increase is 0.15 ms; at 150 ms injected RTT the largest warm median increase is 0.79 ms.
These results do not show a material repair regression, and do not establish a speedup.
Repair measurements use Node for both engine placements and simulated transport; they exclude rendering, startup, real bandwidth restrictions and remote SSH fact round trips.

## Workspace startup and typing

A separate local Chromium benchmark compares the old root page with the new workspace at 390×844.
Readiness waits for a ready shell plus two animation frames.
Echo measures sending one character through WebSocket to its output being drained into the renderer; it is not a physical display or mobile keyboard measurement.
Service workers are disabled to compare the page architectures consistently.

| Mode / UI | First ready (one sample) | Reload median (15 samples) | Echo median (50 samples) |
| --- | ---: | ---: | ---: |
| server / before | 110.4 ms | 78.3 ms | 32.3 ms |
| server / workspace | 175.0 ms | 85.5 ms | 32.2 ms |
| client / before | 122.4 ms | 78.8 ms | 32.2 ms |
| client / workspace | 218.1 ms | 85.6 ms | 32.3 ms |

Typing is effectively unchanged in this check.
The tabbed UI adds about 7 ms to warm reloads and 65–96 ms in these single first-load samples.
Preloading terminal assets and caching both HTML entry points reduces the new load waterfall, but **startup is not performance-neutral**.
Each tab also owns its renderer/WASM and, when applicable, worker, so memory and background work grow with open tabs.
The before/after engine benchmark is not evidence that SSH matches direct-backend latency; remote fact access adds SSH/SFTP network round trips.

[Raw results](../archive/migration/README.md) contain every cold/warm repair case at 0/50/150 ms RTT, local samples in both orders, and browser startup/echo samples.
Reproduce after building:

```sh
BENCH_SUITE=shared BENCH_BEFORE_MASTER=2a99127 BENCH_BEFORE_CLIENT=2a99127 BENCH_REPEATS=5 npm run bench:architecture
# Local CPU sensitivity: repeat with BENCH_RTT=0 BENCH_REPEATS=101,
# then repeat again with BENCH_REVERSE=1.
BENCH_REVERSE=1 BENCH_REPEATS=15 node test/workspace-benchmark.mjs
```

The UI benchmark archives/builds the baseline in a temporary directory and needs Chromium, ports 3164–3167, and the current checkout's installed dependencies.

## SSH entered at a terminal prompt

Entering a literal interactive `ssh host` command in a direct-backend terminal opens a managed SSH tab with remote alternatives.
The original local shell stays open; exiting the remote shell selects it again.
Bash Readline supplies the final line on Enter, covering typed commands, history recall, Ctrl-R, completion and single-line bracketed paste.
No frontend reconstruction of those edits is needed.
Reconnect/terminal-cleanup functions that begin by forwarding unchanged arguments to the standard SSH executable also use the managed handoff, including Omarchy's SSH wrapper.
The definition is inspected without running it; only local variable declarations and timing/status bookkeeping may precede that call.
For captured commands, the managed terminal takes over and the wrapper's later cleanup/retry code does not run.

The backend evaluates OpenSSH configuration with `ssh -G` using the shell's current directory and exported environment.
It tries configured identity files and the available SSH agent.
An already usable key needs no extra passphrase; an encrypted file not unlocked in an agent prompts when needed.
Passphrases are not retained.
Existing OpenSSH known-host entries are checked, unseen host keys require confirmation, and changed keys are rejected.

After successful authentication, the backend vault registers only public metadata and a reference, for example:

```json
{"reference":{"type":"file","path":"/home/user/.ssh/work_key"}}
```

Agent references use `"type":"agent"` and the agent socket path, with the public fingerprint identifying the key.
Both live in the existing backend `vault.json`; private keys remain in their original files or agent.
Repeated use deduplicates references.
The host is saved in the browser with its backend key ID, so it can be opened from Hosts later.
File fingerprint changes are rejected.
Removing a reference does not remove the source key.
Agent references require the original agent socket and key to remain available.
They do not migrate between backends.
Browser-created keys still default to the browser vault.

Unsupported invocations use native SSH: shell expansions/operators, remote commands, forwarding, jump/proxy configurations, certificates and connection multiplexing.
SSH aliases, functions that alter arguments or perform other work before SSH, and replacement executables run normally.
Multi-line paste, Ctrl-J submission, and SSH entered inside an already remote shell also remain native.
Those paths do not gain managed remote alternatives.
The connection dialog offers native SSH or cancellation if managed connection fails.
This requires a newly started backend shell with the Readline hook; pre-existing shells do not acquire it by refreshing the page.

The workspace test additionally checks all five input paths, lost-response/reload recovery without duplicate remote sessions, saved-host reuse, file and agent references, locked-key retries, cancellation, and replacement-key rejection.

### SSH capture latency check

Compared with `b2a0fb4`, two opposite-order local Chromium runs at 390×844 gave these pooled medians (milliseconds).
Each cell includes 100 typing samples, 200 ordinary `:` command submissions, or 18 reloads:

| Case | Server before | Server capture | Client before | Client capture |
| --- | ---: | ---: | ---: | ---: |
| Character echo to renderer drain | 32.3 | 32.2 | 32.1 | 32.1 |
| Enter to next ready prompt | 9.4 | 9.8 | 9.7 | 9.6 |
| Reload to ready + two frames | 120.3 | 113.0 | 114.7 | 117.4 |

Enter-to-prompt p95 was 16.4→15.2 ms (server) and 14.4→14.5 ms (client).
Typing remains effectively unchanged; command submission differences are below half a millisecond at the median.
Client reload increased 2.7 ms in this sample.
These measurements do not establish zero overhead or predict mobile/network latency.
Non-SSH submissions add only a Bash builtin check; configuration/key resolution runs only for captured SSH.
Repair algorithms are unchanged.

[Raw capture comparison](../archive/migration/README.md) includes all samples and both single cold-load observations per variant.
Reproduce after building:

```sh
BENCH_BEFORE=b2a0fb4 BENCH_BEFORE_WORKSPACE=1 BENCH_REPEATS=9 node test/workspace-benchmark.mjs
# Repeat with BENCH_REVERSE=1 and pool both sample sets.
```
