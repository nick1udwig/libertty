# Transport performance

Issue #14 prioritizes end-to-end speed across browser, backend and remote-host hops.
The experiments measure native encoding, an identical peer-process boundary, paced WebSocket transfer, browser decoding and a DOM rendering boundary.
TCP byte counters include WebSocket headers and masking after the handshake, but these local experiments do not include TLS records or SSH encryption overhead.
The fast profile uses 2 ms RTT and 100 Mbps, and the constrained profile uses 150 ms RTT and 1 Mbps with Chromium script CPU throttled sixfold.
Browser throttling does not slow every native browser thread and does not replace measurements on physical mobile hardware.
Raw cold and warm samples, median and p95 latency, upstream and downstream bytes, encoding and decoding time, runtime versions and process memory are retained in `.test-artifacts/transport-experiments.json`.

## Inventory

| Path | Existing behavior | Focus |
| --- | --- | --- |
| Browser ↔ terminal backend | JSON input, sequenced output, acknowledgements, bounded replay | Negotiated compact messages and immediate delivery |
| Backend ↔ native SSH | Encrypted channels shared by PTY, facts, SFTP and Herdr | Compare delayed SSH compression with the current uncompressed path |
| Native SSH fallback | OpenSSH process using the resolved user configuration | Preserve native options and measure alongside shared transport behavior |
| Browser ↔ Herdr | JSON snapshots, base64 ANSI frames, bounded viewer queues | Raw frame bytes, selective compression and unchanged snapshot suppression |
| Backend ↔ direct or SSH Herdr | Shared native frame stream, per-view history polling, event subscriptions | Share history subscriptions and suppress unchanged updates |
| Files and SFTP | Streaming binary upload and download, JSON listing and edits | Retain streaming for incompressible transfers and compress large text responses selectively |
| Reading Mode | Bounded complete file or capture response | Compress suitable text while preserving binary file bytes |
| External plugins | Private capability port and full selected-file polling | Validated unchanged responses, incremental data where safe and visibility-aware reuse |
| Static assets | Existing precompressed Brotli and gzip variants | Retain the established implementation |
| Dictation | Binary Opus with sequence and duration validation | Preserve audio bytes and avoid redundant compression |

## Measurement budgets

The typing p95 budget is the baseline plus the larger of 1 ms or 20 percent.
The constrained bulk-transfer target is at least 25 percent lower median latency for compressible log and ANSI workloads.
Incompressible traffic must stay within the baseline plus the larger of 2 ms or 5 percent.
Interactive input must be sent immediately, and output coalescing may collect already-queued messages without adding a timer delay.
Decoded message size remains bounded, and compression uses independent messages rather than an unbounded connection dictionary.
Idle metadata and unchanged plugin replies should contain no repeated full body after initialization.
Authentication, owner scoping, SSH host pins, plugin capabilities, replay, Unicode and ANSI bytes are correctness gates for every selected method.

Run `cargo build --release --locked -p termai-server --example wire` and `node test/transport-benchmark.mjs` to reproduce the transport comparisons.
The comparison includes ordinary JSON, WebSocket per-message deflate, compressed JSON envelopes, raw binary envelopes and selectively compressed binary envelopes.
The selected methods below follow these measurements for small messages, bulk text, ANSI frames and incompressible data.

## Selected implementation

Production sockets advertise versioned binary, constrained gzip and fast-link gzip capabilities in authenticated connect and ticket replies.
New clients offer only advertised protocols and fall back to legacy JSON with older backends.
Without browser decompression support, raw binary remains available.
Input, acknowledgements and geometry use compact binary fields, terminal output retains its sequence, and Herdr frames carry their original ANSI bytes directly.
Decoding remains ordered across asynchronous decompression and discards results from replaced sockets.
Connect and ticket replies advertise application heartbeat support independently of the encoding.
After two idle seconds, browsers ping the terminal or metadata socket and report a stall after four seconds without incoming traffic.
A replacement handshake keeps the previous socket alive and the last painted screen visible until takeover, and user activity bypasses reconnect backoff.
Older servers without the heartbeat capability retain their existing reconnect behavior.
Audio retains its existing Opus bytes inside a distinct four-byte envelope and is never compressed.
Each compressed message uses gzip level 1 with an independent dictionary and must save at least one eighth of the original representation.
Constrained links compress messages from 2 KiB, while ordinary links compress only messages from 128 KiB.
The browser selects the constrained profile only when its connection information reports 2G/3G or at most 2 Mbps.
Large bounded HTTP text and JSON responses use the same thresholds and gzip acceptance checks, with `Vary` covering the negotiated profile.
Existing precompressed static assets and streaming binary transfers retain their current paths.
No buffering timer is added to input or output delivery.

Native SSH enables delayed `zlib@openssh.com` compression only when the auto-route TCP probe averages at least 40 ms, or an API caller explicitly selects `compression: "on"`.
Compression starts after authentication and falls back to uncompressed SSH when unsupported.
Fast and fixed routes keep the uncompressed preference, and the OpenSSH fallback preserves the user's resolved configuration.
Latency is a profile hint rather than a bandwidth measurement, so unusually fast-bandwidth high-latency routes may benefit less than this constrained fixture.

Selected-file plugin reads validate a SHA-256 version and return HTTP 304 without a body when unchanged.
Native files reuse a bounded snapshot only while inode, size, mode, nanosecond modification time and change time match.
Rotation, rewrites, truncation and binary content are revalidated.
Remote reads validate UTF-8, size and the digest on the remote host through a bounded Python helper, reducing SSH bytes for unchanged files.
Hosts without the helper retain the SFTP fallback.
Append deltas require the same selected path and exact base version, and fall back to a full bounded snapshot after rotation or truncation.
The private plugin port also sends unchanged or append messages while its SDK reconstructs the existing complete `file.read` result.
Snapshots remain scoped to the backend, session, selected file and credentials, and no new plugin permission is introduced.
The sample skips rendering unchanged content and keeps its existing hidden-view polling pause.

Herdr history viewers share one upstream poll per transport, socket and pane with latest-value replay for new viewers.
The final viewer cancels the poll, and slow viewers receive only the latest pending history rather than an accumulating queue.
Identical metadata snapshots are suppressed while periodic recovery and changed status notifications remain active.
The existing frame hub continues sharing the native ANSI stream.

## Measured comparisons

The initial fifteen-warm-sample experiment produced these end-to-end medians, with p95 in parentheses, in milliseconds.

| Constrained browser workload | JSON | Binary plus selective gzip | TCP downstream bytes before → after |
| --- | ---: | ---: | ---: |
| Typing echo | 153.1 (155.1) | 153.5 (155.3) | 53 → 28 |
| Unicode logs | 787.0 (790.0) | 163.7 (165.5) | 78,045 → 631 |
| ANSI frame | 449.1 (451.7) | 159.1 (160.9) | 36,872 → 323 |
| Random frame | 857.8 (861.8) | 682.4 (684.4) | 87,462 → 65,555 |
| Agent metadata | 243.3 (245.4) | 163.3 (165.8) | 11,127 → 761 |
| Plugin model | 2,090.8 (2,093.9) | 176.5 (179.6) | 240,069 → 1,639 |

On the fast profile, compressing every eligible 2 KiB message did not improve ordinary log or ANSI rendering and increased decode work, so the higher threshold is selected there.
The 240 KB plugin model improved from 26.8 ms median and 40.2 ms p95 to 6.5 ms median and 7.4 ms p95 on that fast profile.
Per-message deflate and compressed JSON also improved constrained bulk traffic, but raw binary independently removes JSON escaping and base64 overhead without requiring compression support.
Independent application gzip is supported by the current server stack and has no retained cross-message dictionary.
The raw representation is retained for incompressible data instead of sending an expanded compressed body.
A repeat during concurrent browser and unit-test work produced noisy fast-profile tails, including a typing-budget miss, and is retained in `transport-selected-fast.json` rather than discarded.
The isolated final fast-profile run and the constrained verification run compare decoded payload hashes as well as timing.

The encrypted-hop experiment uses a temporary real OpenSSH server and bounded FIFO pacing in both directions.
Its counters include SSH encryption, padding, channel messages and authentication where applicable, and exclude TCP/IP headers.
The seven-sample uncompressed versus compressed 230 KB text read improved from 2,194 ms to 395 ms on the constrained profile in the first run.
Constrained typing stayed about 390 ms in both modes, including channel and process setup.
Random data on the fast profile regressed from 58 ms to 98 ms with compression, which supports retaining the uncompressed fast-route preference.
Startup was approximately 2,502 ms versus 2,508 ms on the constrained profile and 314 ms versus 324 ms on the fast profile.
`transport-ssh.json` retains the final run with additional full-SFTP versus unchanged-plugin polling measurements.
With compression enabled, unchanged remote plugin polling improved from 2,563 ms and 1,752 downstream bytes for a complete SFTP read to 390 ms and 252 bytes.
Without compression, the same constrained comparison improved from 4,360 ms and 231,096 bytes to 402 ms and 372 bytes.
On the fast profile, unchanged polling improved from 266 ms to 91 ms without compression.
The isolated browser verification passed typing p95 at 14.5 → 15.0 ms on the fast profile and 154.8 → 154.7 ms on the constrained profile.
The constrained bulk medians were 787.9 → 163.6 ms for logs and 449.4 → 158.8 ms for ANSI frames, while random-frame p95 improved from 859.5 → 683.7 ms.

Native encoding time and browser decode time are recorded separately in the browser artifacts, alongside process memory.
The SSH fixture uses the current host CPU without throttling, and its command completion boundary is not a terminal paint measurement.
The browser experiment paints a DOM representation rather than the Ghostty GPU surface, while production browser regressions verify the actual terminal, acknowledgements, replay, Herdr, files, plugins, dictation and permissions.
Physical mobile devices, macOS ARM, TLS record overhead and server-wide CPU profiles remain outside this local experiment.
Those deployment measurements should supplement these reproducible gates before changing thresholds for a specific environment.

Reproduce the encrypted-hop comparisons with `cargo test -p termai-server --test ssh transport_ssh_benchmark -- --ignored --nocapture`.
Use `WIRE_VARIANTS`, `WIRE_PROFILES`, `WIRE_SAMPLES` and `WIRE_OUTPUT` to retain separate browser verification runs.
Generate fresh selected-profile reports before running `node test/transport-budgets.mjs` to check typing, bulk-transfer and incompressible-traffic budgets.
The budget check reads `.test-artifacts` by default, or an alternative directory supplied through `WIRE_RESULTS_DIR`.

```sh
cargo build --locked --release -p termai-server --example wire
WIRE_PROFILES=fast WIRE_VARIANTS=json,gzip-fast WIRE_OUTPUT=transport-selected-fast-final.json node test/transport-benchmark.mjs
WIRE_PROFILES=mobile WIRE_VARIANTS=json,gzip WIRE_OUTPUT=transport-selected-constrained.json node test/transport-benchmark.mjs
node test/transport-budgets.mjs
```

Recorded experiment reports are available in Git history rather than the working tree.
Fresh benchmark reports are written to ignored `.test-artifacts` files.

## Herdr space switching

The authenticated terminal ticket now includes measured mobile columns and rows, and the frame hub opens its controller directly at that size.
This avoids creating a desktop observer and subsequently replacing it after a browser resize message.
New mobile subscribers reject a cached baseline from a different geometry, and joining an incremental stream requests a complete baseline.
Geometry retains the existing 1–1,000 column and row bounds, owner-scoped tickets and desktop observer behavior.
Older servers without `initialGeometry` retain their existing client path.

The first fix waited two animation frames after a matching grid, but a correctly sized grid can still contain the application's desktop content.
A responsive application delaying its SIGWINCH redraw by 200 ms reproduced approximately 166 ms of visible desktop content with that fix.
The original animation-frame assertions inspected terminal buffers and missed some composited pixels and parent-iframe visibility transitions.
The failed slow-redraw trial remains available in Git history.

The new layout barrier records Herdr's native content revision before acquiring or changing mobile geometry.
Herdr 0.9.3 [advances that revision twice for a resize and twice for each processed PTY read](https://github.com/herdrdev/herdr/blob/v0.9.3/src/pane.rs), so a geometry-only revision cannot certify application output.
The barrier waits for a complete matching grid and subsequent PTY output, requests a fresh full frame, and paints the native baseline before revealing the viewport.
An unchanged revision accepts an already matching grid without waiting for a resize that did not occur.
Rapid switches preserve an unfinished redraw check, while newer geometry and parked views cancel superseded checks.
Revision probes are sequential, cancellable and spaced by 20 ms rather than delaying every reveal by a fixed interval.
Herdr does not expose an application-level redraw-completion acknowledgement, so static applications have a two-second fallback and older Herdr versions without the revision API retain a compatibility fallback.
The revision is obtained through the read-only `pane.copy_motion` operation rather than `pane.read`, whose current exported revision does not track terminal content.

Mobile space switches retain up to four authenticated terminal iframes in least-recently-used order.
Parked views keep their native mobile geometry while consuming and discarding stream frames on the backend, and they pause browser output and shared history polling.
The initial warm-switch optimization showed its last certified mobile image immediately while reacquiring controller priority and fresh state.
The loading handoff described below now retains the currently displayed view until the selected pane has a fresh certified paint.
Uncertified incoming frames cannot overwrite that retained image.
Cold views and changed dimensions stay hidden until the new layout barrier completes.
Eviction, removal, disposal, leaving the top-level Herdr tab and changing to a desktop layout release the relevant mobile controllers.
Returning to the top-level tab opens fresh connections and waits for mobile sizing again.
Older backends without the advertised parking capability retain the single-iframe lifecycle.

The expanded real-Herdr regression captures Chromium's composited PNG frames and checks for the fixture's red desktop pixels in addition to inspecting every visible terminal buffer.
Its green mobile caption and complete border must agree with the current grid on every visible sample.
It verifies cold opens, warm switches, top-level leave and return, bounded cache eviction and desktop release.
Delayed redraws of 200 ms and 600 ms, constrained gzip transport and sixfold script CPU throttling are included.
The fixtures use an isolated Herdr server and a 150-by-45 desktop client, with a browser viewport of 390 by 844 pixels.
These are browser-emulated mobile measurements rather than physical-device measurements.

The isolated normal run measured nine warm switches at 52.7 ms median and 54.5 ms p95, while its single cold switch took 405.4 ms.
The previous implementation recreated each iframe and measured 392 ms median in its gzip run, so warm reuse improves that observed switch latency by approximately 7.4 times.
These figures compare the old cold lifecycle with the new warm lifecycle rather than claiming faster cold initialization.
With a 200 ms application redraw delay, warm switching remained 52.6 ms median and 54.2 ms p95, while the single cold switch took 505 ms.
The normal run's three top-level returns took 193.9–404.4 ms, with a median of 244.4 ms.
With a 600 ms redraw delay, gzip and sixfold CPU throttling, nine warm switches measured 142.3 ms median and 180.6 ms p95, the cold switch took 1,460.3 ms, and three top-level returns had a 1,058 ms median.
Delayed returns wait for the application to redraw instead of exposing desktop content during that interval.
Across these four final runs, 36 space switches and 10 top-level returns passed, and none of the 550 captured composited frames contained desktop pixels while the mobile view was active.
The historical normal, delayed, throttled and six-space eviction samples remain available in Git history.
Fresh Herdr test reports and composited images are written to ignored `.test-artifacts` files.

Run `npm run test:herdr-flash` for the default case, and use `TEST_REDRAW_DELAY=600 TEST_CPU=6 TEST_WIRE=gzip` for the slow-redraw case.
Use `TEST_SPACES=6 TEST_SWITCHES=6 TEST_RETURNS=1 TEST_REDRAW_DELAY=200` to verify cache eviction and controller release.
Run `npm run test:herdr-resize`, `npm run test:herdr-scroll` and `npm run test:herdr` for keyboard geometry, multiple viewers, live scrolling, selection, links and the wider Herdr lifecycle.
The lifecycle test runs against the native Rust backend.

## Herdr loading handoff

Selecting a pane or top-level Herdr tab prepares the incoming view at its full on-screen dimensions behind the current view.
The current view remains visible with a small loading indicator and cannot receive input during the transition.
Initial opens and returns without an available previous view show a full loading panel.
The swap occurs only after the incoming terminal has a complete matching mobile grid, passes its redraw barrier and paints across two animation-frame boundaries.
Each selection has a fresh presentation identifier, and the terminal reports its current columns and rows separately from its rendered acknowledgement.
The parent rejects acknowledgements for superseded selections or earlier dimensions, including a viewport change during loading.
Rapid selections can cancel a pending switch without exposing its unfinished pane.
If returning to the displayed pane requires different dimensions, a separate iframe prepares the new grid while the old iframe remains frozen until the handoff completes.
Old iframes are retired after the swap, and leaving or disposing the view also cleans up a temporarily retained iframe.
Legacy backends keep the previous iframe frozen during the handoff without requiring backend parking support.
Once a mobile pane has passed its paint barrier, keyboard resizes retain that view and its focused input while awaiting the new geometry and redraw.
The mobile paint certificate resets on reconnects and desktop layouts, so an initial desktop grid still waits behind the loading gate.

Run `npm run test:herdr-loading` to exercise cold loading panels, pane and top-level handoffs, stale acknowledgements, viewport changes, cancellation, live composited canvas updates and input delivery through keyboard opening and dismissal.
The native flash test samples visibility from the parent window, so it includes the old displayed pane and the incoming pane across iframe visibility transitions.
The real-Herdr test also captures composited browser pixels independently of the terminal-buffer assertions.
