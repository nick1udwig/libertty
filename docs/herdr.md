# Herdr connection

Type `herdr` in a Termai terminal on a local or SSH machine to save and open its Herdr host automatically.
Named sessions support `herdr --session NAME` and `herdr session attach NAME`.
Command capture reads the final Readline buffer, so history, completion and pasted commands work too.
Help, API commands, shell operators, aliases and functions retain their normal shell behavior.

A plain launch starts an absent headless server, matching normal Herdr startup.
Choose **Connect Herdr** from any ordinary HTTP or SSH host's menu, with an optional named session.
This creates a dedicated connection without a terminal or PTY and starts an absent server.
SSH uses the existing keychain, routing and fingerprint checks.
Older **Connection → Herdr** profiles remain supported.
Closing a view keeps Herdr and its agents running.

Captured SSH discovery reuses the source terminal's authenticated transport to forward Herdr's Unix socket.
OpenSSH must allow Unix socket forwarding.
Keep that source terminal open while using its Herdr view.
After a backend restart, reconnect the source host and run `herdr` again; the saved host is reused.
Connections opened with **Connect Herdr** own their SSH transport, so closing other terminals does not disconnect them.
Reopening the app automatically restores expired Herdr source connections through their saved host and refreshes the connection when the app returns to the foreground.
If an SSH key needs unlocking, the app opens its credential dialog during restoration.
Closing their top-level tab releases that transport and its notification watches.
After a backend restart, close the ended tab and connect again from its host menu.

## Terminal interface and mobile sizing

Swipe up on the Herdr strip to reveal terminal tabs, or swipe down on either navigation strip to hide them.
The terminal tabs follow your finger out from behind the Herdr strip and slide back behind it as you swipe down.
Releasing settles the strip open or closed, while short or cancelled swipes return to their starting state.
The arrow button provides the same controls, while horizontal swipes scroll tabs and holding opens tab actions.

At a Herdr shell prompt, `look at FILE`, `look at COMMAND` and `COMMAND | look at` open Reading Mode in a top-level workspace tab.
Typed requests and dictated alternatives use the selected pane's working directory and the Herdr host's existing connection.
Reading commands run once in a separate Bash context using the connection environment rather than the pane's interactive variables or functions.
Commands have a 30-second limit and use the reader's existing 20 MB output limit.
Readers preserve their connection across reloads and relative file links, and closing a reader returns to its Herdr tab.

Every selected agent opens the same terminal.html / terminal.ts pane as a normal terminal.
Input, dictation, configurable shortcuts, IME focus, touch scrolling, selection handles, automatic copy, terminal links and the history scrollbar all use the existing implementations.
There is no separate message composer.

The `herdr terminal session observe` or `control` stream supplies live ANSI frames.
Mobile TUI panes whose dimensions match the shared terminal apply those full frames and incremental updates directly to the ordinary Ghostty terminal, including native cursor positions, colors and OSC-8 links.
Text updates no longer wait for a history read.
Delayed snapshots cannot overwrite a newer live frame.
When a pane joins an existing incremental stream or switches from shell history into a TUI, it requests a complete baseline through an unchanged native resize; this requests Herdr's repaint using the current controller's dimensions.

The gateway also reads `pane.read` with source `recent_unwrapped` and ANSI formatting while visible, at most once every 150 ms after the preceding response.
Herdr limits a read to 1,000 logical lines.
Snapshots supply initial history and fallback rendering.
Shells with terminal scrollback and differently sized observers wrap that history in their own Ghostty buffer.
In this fallback, Ghostty maps the live cursor through the native and local widths; a cursor stays hidden while the snapshot and frame disagree rather than appearing at the bottom.

The shared touch handlers ignore temporary scroll events during anchored output updates, keeping hold/drag selections and copying usable while an agent redraws.
Scrolling, selection handles and plain, wrapped or labeled link taps all use the same TerminalGestures implementation as ordinary terminal panes.

A visible mobile pane (coarse pointer and viewport at most 1,024 CSS pixels wide) uses `herdr terminal session control --cols N --rows N` to resize that terminal’s actual PTY to its Ghostty cell grid.
Rotation, font changes and keyboard appearance send `terminal.resize` through the existing controller.
The app redraws at the native mobile width, including its own borders, composer, status and wrapping.
The desktop sees the same narrower terminal; a PTY has one shared size.

Each terminal has one shared controller per backend/SSH transport.
The most recently resized mobile viewer owns geometry; desktop web viewers only observe.
Hiding a pane, backgrounding the app or closing its connection releases that viewer’s claim, including while dictation keeps its transport alive.
Other mobile viewers retain control.
A heartbeat releases disconnected viewers after at most about a minute if their close message cannot arrive.
When the last mobile leaves, `terminal.release` detaches the controller and Herdr restores its desktop shell client’s geometry.
Without a desktop client, Herdr determines the remaining geometry.
This integration never uses `--takeover`; an existing external controller causes an error rather than being disconnected.
Only the selected terminal is resized.

Terminal scrollback and selection remain local.
When the mobile viewport has no local scrollback, vertical drags send `terminal.scroll` wheel events through its scoped controller.
Herdr routes these to the app’s own scroll handler or native terminal history.
Apps that own their history share that scroll position with the desktop.
The shared gesture code also preserves momentum and hold-to-copy.
Typing uses `pane.send_text`; dictation uses `pane.send_input` to respect the application's paste mode without submitting it.
Shell panes use Herdr’s foreground process information to enable command alternatives after dictation, including spoken directory commands such as `C D`.
Corrections replace only the latest dictated text and preserve surrounding input.
Edits from another viewer invalidate the correction before it can replace or submit that input.
Agent and other foreground application panes keep literal dictation.
Input is serialized and validates the current agent before writing.
Uncertain input is never replayed after a disconnect.
Older scrollback and applications that do not handle terminal resizes can retain their original formatting.

## Tabs, names and notifications

Agent names use the session's actual pane label, with presentation title, agent name and terminal-title fallbacks.
Rename uses the same `pane.rename` action as Herdr's desktop Rename pane menu.
Printable labels can contain spaces and capital letters (up to 100 characters).
Desktop changes propagate through snapshots; mobile changes update that shared label.
Agent API addresses remain independent.
Top-level Termai tab names are local workspace labels.

Settings → **Herdr strip shows** switches between **Spaces** (default) and **Agents**, preserving an explicit mode choice.
Settings → **Herdr strip order** defaults to **Status lanes**, which group chips by urgency with the idle lane folded; **Manual** keeps your dragged order.
The space or agent strip sits at the bottom of the terminal view, above Termai’s terminal tabs and configurable shortcut buttons.
Hold menus open upward so their actions remain visible above the controls.
**+** creates a new space with a shell in the selected terminal’s working directory, without a popover or form.
Creating from Agents switches the view to Spaces so the new space is visible.
Spaces include ordinary terminals.
Once a repository has a worktree, Herdr reports its repository and the strip shows its checkouts as one chip.
A grouped chip shows the repository name and checkout count, and while selected also names its current checkout.
Other spaces, including repositories without worktrees, keep their own chips.
Selecting a chip reopens the checkout and pane last used in it.
Settings → **Tapping a repository with worktrees opens** can instead open the most urgent worktree, the root checkout, or the tree without selecting a checkout.
Most urgent ranks agent panes by needing input, then unseen finishes, then working, then seen finishes, and picks the oldest Herdr state change within the first nonempty rank.
It opens that pane directly, and falls back to the last used checkout when no agent pane has a status to rank.
Agent creation lets you choose a name, agent type and directory; the type must be installed on that host.

Swipe left or right to scroll the strip in either Spaces or Agents mode.
Tap the selected chip again, or hold any chip, to open its tree, which grows out of the chip above the strip.
The tree shows the root checkout with its worktrees nested beneath it, and each checkout's panes as pills.
Tap a checkout or pane to open it, or hold its name to rename it in place.
Enter or the check button saves a rename, and Escape cancels it.
**+ split** splits that checkout's remembered pane, falling back to its desktop-selected pane.
**×** on a pane closes it at once and keeps the tree open, while **×** on a checkout asks before closing its space.
**New worktree** and **Open worktree…** start from the root checkout just as on desktop, and are unavailable while only worktrees are open.
New worktree creates a branch from `HEAD` in Herdr’s configured worktree directory, while Open worktree lists existing usable checkouts.
Split offers Right and Down, and the tree immediately includes the new pane; desktop and mobile see the same worktrees and splits.
While a tree is open, tapping another chip opens that chip's tree without changing the selection.
Tap elsewhere, press Escape or swipe the tree down by its grab bar to dismiss it.
The dialogs show progress and errors, prevent repeated submissions, and preserve selection on cancellation or failure.
Closing a linked worktree's space also offers Delete checkout, which removes the checkout folder and closes its Herdr workspace while preserving the Git branch.
If deletion reports that `--force` is required, the dialog shows a Force delete button that discards modified and untracked files in that checkout.
Local and SSH connections route these actions through their selected Herdr server and session, with update guidance if its API is unavailable.
Split checks that the Termai backend supports the action before submitting it, so an older running backend reports the version mismatch.
After rebuilding the interface and backend, restart the Termai service to activate the backend changes.
Use `npm run build:release` when the service runs `target/release/termai`, so both the optimized backend and the interface are rebuilt together.
Hold, then drag onto the left or right edge of another chip to reorder; drop on its middle to stack the chips.
A repository chip moves all of its checkouts together.
The count button expands or collapses a stack.
Expand it and drag a member to an edge to remove it.
Stacks keep their spaces and terminals separate.
Reordering uses Herdr’s native workspace order; arbitrary stacks are saved in the web app because Herdr’s API does not expose them.
Cancelling a drag changes neither membership nor order.
In Agents mode, holding then moving reorders agent tabs, while an immediate swipe scrolls the strip.
Keyboard users can use Shift+F10 to open a tree or rename within it, arrows to select and Alt+arrows to reorder.
Spaces aggregate agent status; renaming a space updates Herdr’s shared workspace label.

Agent order, space stacks, each repository's last checkout, selected terminal and viewed-completion acknowledgements are saved in browser local storage per backend, source machine and Herdr session.
Closing an agent tab closes its Herdr pane on the server and ends its process.
Closing a space closes that server workspace and its terminals.
Rejected closes keep the tab visible and show Herdr’s error.
Closing the top-level Herdr tab disconnects its notifications.
Ordinary shell tabs retain their stop-process confirmation.

Hollow green is idle, orange is working, red is blocked/requesting attention, and blue is completed but not yet viewed here.
Viewed acknowledgements are local; desktop focus does not clear this browser's unread completions.
Servers with completion_seq report completion directly.
Older versions use done status or an observed working-to-idle transition, so completions entirely during a disconnect cannot always be detected.

Metadata stays connected while another top-level tab is selected.
After a browser gesture enables audio, the official done/request sounds play while the webapp is visible and focused, regardless of the selected tab.
Initial/repeated snapshots are quiet, and unfocused notifications are not queued for later playback.

## Backend and API

Default socket: XDG_CONFIG_HOME/herdr/herdr.sock, otherwise HOME/.config/herdr/herdr.sock.
HERDR_SOCKET_PATH overrides the default session's socket.
Named sessions use sessions/NAME/herdr.sock below the same config directory.
Discovery resolves these paths from the source shell's environment.
HERDR_CONFIG_PATH affects configuration, not socket location.

The integration requires session.snapshot, events.subscribe, pane.rename, pane.read with recent_unwrapped, pane.send_text and pane.send_input.
Shell alternatives also require pane.process_info.
The read-only history API was verified against the installed Herdr 0.9.3 server.
The Herdr CLI is also required on the target host for live frame streams and scoped PTY control.
Agent creation uses `server.agent_manifests`, `tab.create`, `pane.rename` and `agent.start`; space renaming uses `workspace.rename`.
Closing uses `pane.close` or `workspace.close`, with worktree-group closing disabled.
Space creation uses `workspace.create` with the selected space and an explicit directory; reordering uses `workspace.move_block`.

The gateway accepts fixed actions and checks agent IDs against the selected server.
Backend pairing and origin checks apply.
WebSocket tickets are short-lived, single-use and scoped to the Herdr session, source transport and selected terminal.
SSH sources belong to the paired browser that opened them.
Clients cannot provide arbitrary socket paths or shell commands to this gateway.

## Sounds and validation

Settings → Background notifications offers an Enable button for each backend when termai is open as an installed PWA over HTTPS.
Permission is requested only on that tap.
Focused workspaces play the official Herdr sounds even when another top-level tab is selected; unfocused devices receive a visible Web Push alert.
Alerts show up to 280 characters from the agent’s latest response first, followed by its working directory, without a status prefix.
A passive ANSI `pane.read` supplies the preview after verifying the pane still belongs to the same terminal.
Input borders, composer and footer are excluded where identifiable.
If output is unavailable, the directory still appears.
Preview text is never saved in notification state.
The notification requests vibration, while the OS controls sound, vibration, Focus/Do Not Disturb and notification permission.
iOS/iPadOS requires a home-screen web app and version 16.4 or later.
See https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/.

The backend watches agent transitions independently of browser WebSockets, so alerts can arrive when the PWA is suspended or closed.
Each backend owns a separate notification worker scope and persistent VAPID key.
Pairing digests, push subscriptions, watch descriptors and status checkpoints live in private files under TERMAI_DATA_DIR; terminal output and SSH secrets are not stored there.
Rotating the pairing token revokes notification ownership.
Local watches resume after backend restart.
SSH watches survive browser closure, but after backend restart their source host must reconnect.
Closing a top-level Herdr connection stops its alerts; closing just the browser keeps watches active.
Enable/disable applies to this browser/device.
Tapping an alert opens the corresponding connection and agent, including when the app has to start first.

Delivery needs outbound HTTPS to the browser's push service.
The server accepts Apple, Google, Mozilla and Windows push endpoints, with bounded watches, bounded pending delivery, expired-device cleanup and transient-error retries.
An optional TERMAI_PUSH_CONTACT sets the VAPID contact URI; by default it uses the configured public backend host.
First snapshots and reconnects do not replay old alerts.

Settings → Herdr terminal layout defaults to Reflow text for desktop web viewers.
Full width preserves the server’s current column count for apps with borders, tables or columns, with sideways panning through the shared TerminalGestures code.
Both use ordinary vertical scrolling, hold-to-copy, selection handles and the history scrollbar.
Mobile always resizes the real PTY and fits its viewport, even when Full width was previously saved.
Each viewer owns its font size and terminal scrollback position; an app’s internal viewport remains shared.
There is no application-specific layout adapter.

src/assets/herdr/done.mp3 and request.mp3 are unchanged copies from https://github.com/herdrdev/herdr/tree/2563803dca97c040beaf3dc3acdcb5a3221b4238/assets/sounds.
The upstream AGPL-3.0 license is distributed as public/HERDR-SOUNDS-LICENSE.txt; public/THIRD-PARTY-NOTICES.txt identifies these assets separately from Termai.

Run npm run build, npm test, npm run test:herdr, npm run test:herdr-resize, npm run test:herdr-scroll, npm run test:herdr-spaces, npm run test:workspace, npm run test:gestures and npm run test:touch.
Fixture tests use disposable socket, dictation and SSH servers and cover shared mobile controllers, multiple viewers, resize bounds, stale/disconnected views, desktop observation, release, raw input, dictation, touch scrolling/copy, shared labels, menus, ordering, persistence, server pane/space closing, creation, status/sounds, PWA notifications, authentication and ticket scope.
The native resize browser test needs an installed Herdr CLI (HERDR_BINARY overrides /usr/bin/herdr).
It creates an isolated Herdr desktop, responsive terminal application and Termai backend with disposable HOME and sockets; it verifies native redraw, border and cursor alignment, keyboard geometry, desktop observation and restoration.
It never touches user agents.
The native scroll browser test also needs Herdr and uses an isolated fullscreen app with zero terminal scrollback.
It verifies multi-line touch wheel delivery in both directions, local selection/copy, plain and OSC-8 links and suppressed keyboard focus.
It checks shell-to-TUI and joining-view baselines, animation with history snapshots withheld, incremental frame rendering and rejection of stale snapshots.
