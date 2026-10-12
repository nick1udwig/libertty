# Runtime plugin experiment

Termai's host menu gets its connection actions from a plugin registry.
Terminal, SFTP / Files, Herdr and Reading Mode are included.
Browser plugins can add a connection action and a tab at runtime by loading a package in Settings, without rebuilding Termai or restarting its server.
Reading Mode opens through terminal reading phrases such as `look at README.md` or `git diff | look at`, rather than a host-menu connection action.

This experiment supports browser views with permission to read one user-selected text file and save their own view state.
Pairing, SSH authentication, routing, credentials and resource cleanup stay in Termai.
New machine-side protocols still need a backend provider; packages cannot install server code.

## Try the log viewer

1. Build and start Termai normally with `npm run build` and `npm start`.
2. Open **Settings → Plugins → Load plugin package** and select [`examples/plugins/example.log-viewer.termai-plugin.json`](../examples/plugins/example.log-viewer.termai-plugin.json).
3. Open a saved HTTP or SSH host's menu and select **Connect Log viewer**.
4. Choose a UTF-8 text file on that host.
   Relative paths resolve against the connection's starting directory.
   The resolved absolute path becomes that tab's file permission.

The viewer refreshes every two seconds while visible with Follow enabled.
It pauses when its tab, workspace or browser document is hidden.
Filter and Follow preferences survive reloads.
The backend accepts regular files up to 20 MB and returns the latest 256 Ki characters; the sample displays at most 2,000 matching lines.
This is polling for small logs, rather than an efficient tail stream for large files.

## Connect Herdr

Choose **Connect Herdr** from an ordinary HTTP or SSH host's menu and enter an optional named session.
An absent server starts automatically.
Herdr gets a dedicated connection without creating a terminal or PTY, and SSH authentication uses the existing keychain, route selection and fingerprint checks.

Closing another terminal does not end this Herdr connection.
Closing its top-level tab releases its transport, live streams and notification watches while leaving Herdr's agents running.
Closing just the browser keeps the backend connection and notification watches available.
Reloading restores the connection while the backend is alive.

After a backend restart, close the ended tab and connect again from the host menu.
Passwords and key passphrases are not retained for automatic SSH reconnection.
Older saved Herdr profiles and shell-command capture continue working through their existing source-terminal descriptors.

## Build a package

A package is a JSON object containing `manifest` and `view`.
The view is self-contained HTML, CSS and JavaScript.
The sample's editable sources live in [`examples/plugins/log-viewer`](../examples/plugins/log-viewer).

```json
{
  "manifest": {
    "id": "example.log-viewer",
    "name": "Log viewer",
    "version": "1.0.0",
    "apiVersion": 1,
    "connectLabel": "Connect Log viewer",
    "permissions": ["file.read"],
    "icon": "≋"
  },
  "view": "<h1>My view</h1><script>/* plugin code */</script>"
}
```

Use a unique ID of 3–64 lowercase letters, digits, dots or hyphens, beginning with a letter.
Built-in IDs are reserved.
Packages are limited to 256 KB and this browser can retain up to 16 package versions, subject to its storage quota.
Names, labels and optional icons are rendered as text.

Package the sample, or another directory containing `manifest.json` and `view.html`, with:

```sh
node examples/plugins/package.mjs
node examples/plugins/package.mjs /path/to/my-plugin /tmp/my-plugin.termai-plugin.json
```

Building a plugin is independent of Termai's Vite build.
Bundle any libraries into the HTML or inline JavaScript yourself; the frame does not fetch scripts, styles or fonts from external URLs.

## Browser API

Termai injects `window.termai` into the isolated frame.
Wait for `termai.ready` before using its connection:

```js
const { name, state } = await termai.ready;
const { path, text, truncated } = await termai.request('file.read');
await termai.request('state.save', { filter: 'warning' });
const unsubscribe = termai.onVisibility(visible => {
  // Start or pause polling here. Also check termai.visible on startup.
});
```

`file.read` accepts no arguments.
The host bridge chooses the backend, session and selected path; a plugin cannot widen its scope by passing another path or session.
`state.save` accepts JSON up to 16 KB and stores it only on this tab.
Read the restored value from `termai.ready`.
`name` is the tab's display name, and visibility includes the selected tab, workspace page and document visibility.
Requests time out after 15 seconds; at most four are handled concurrently per view.
Other operations are rejected.

Plugins use a sandboxed iframe with scripts enabled and an opaque origin.
A private MessageChannel carries the API.
They receive no backend token, pairing code, keychain access or host storage.
The frame's Content Security Policy blocks direct fetches, external assets, nested frames and form submission.
Its parent DOM and browser storage are inaccessible.
These boundaries restrict app access; a frame can still consume CPU or navigate itself, so the experiment does not guarantee freedom from denial of service or data disclosure by a plugin granted a file.
Install code you trust with that file.

## Versions and lifecycle

Installed packages and tab references live in browser storage.
Each tab pins its package ID and version.
Loading a new version makes it the connection action used for new tabs, while existing tabs continue using their pinned version.
A previously installed version cannot be overwritten in place.
Packages are embedded from browser storage, so the service worker's build-time asset cache does not replace them.

Settings can disable or remove an external plugin.
Its open tabs show an unavailable-plugin message and retain their state and file permission.
Enabling or reinstalling the pinned version restores those views.
Their backend sessions remain owned by the tabs until the tabs close; closing an unavailable tab still releases its connection.
Removing a plugin removes all installed versions of its ID.
Clearing browser storage loses packages, profiles and tab references.

Built-ins and external packages implement the registry's `TabPlugin` contract in [`src/plugins.ts`](../src/plugins.ts): connection availability and action, metadata, mounting and closing.
Mounted views supply `setVisible` and `dispose`, with optional focus, settings and selection methods.
Built-ins keep their existing trusted views and terminal frames.
The workspace performs common mounting, restoration, switching and disposal.
Legacy terminal/file/Herdr modes and saved Reading Mode tabs migrate to plugin IDs.
Reading Mode uses the same tab storage and view lifecycle as the other plugins, preserving file previews, Markdown links and captured command output.
Its tabs borrow the source terminal's session, so closing a reader releases its captured output and view resources while keeping the terminal running.

## Validation

`npm run test:plugins` uses disposable localhost, SSH and Herdr fixtures to check runtime installation, local and SFTP reads, file-scope enforcement, parent/storage/network restrictions, saved state, pinned versions, disabled and missing packages, mobile width, connection ownership, and cleanup.
It also opens Herdr directly over SSH and closes an independent terminal while Herdr remains usable.
A mobile screenshot is saved to `.test-artifacts/plugins-mobile.png`.

The unit suite covers registry migration, version selection, manifest validation and denied bridge operations.
The production build and unit suite pass (207 tests, one skip), as do the workspace, Herdr, Reading Mode and terminal-gesture browser checks.
Cross-browser sandbox support still needs verification.

## Terminal latency check

Two local Chromium runs in opposite order compared the pre-plugin revision `243b689` with this implementation at a 390 × 844 viewport, with no external plugins installed.
Service workers were disabled, and there was no network delay or CPU throttling.
Each cell pools ten warm reloads, 100 character echoes and 200 ordinary command submissions.
Times are medians in milliseconds.

| Engine | Warm reload before → plugins | Character echo before → plugins | Command submission before → plugins |
| --- | --- | --- | --- |
| Server | 113.8 → 101.0 | 32.2 → 32.3 | 11.9 → 11.8 |
| Client | 99.9 → 113.8 | 32.2 → 32.3 | 11.7 → 11.7 |

Typing and command submission stayed close in this sample.
Client-engine warm reload increased about 14 ms.
Startup results varied, and these measurements do not establish a server-engine speedup, startup parity, or performance on a physical phone.
Additional installed packages can add startup and memory costs.
[Raw measurements](plugin-results.json) include individual samples and first-load observations.

Reproduce the comparison against the pre-plugin revision after building:

```sh
BENCH_BEFORE=243b689 BENCH_BEFORE_WORKSPACE=1 BENCH_REPEATS=5 node test/workspace-benchmark.mjs
BENCH_BEFORE=243b689 BENCH_BEFORE_WORKSPACE=1 BENCH_REPEATS=5 BENCH_REVERSE=1 node test/workspace-benchmark.mjs
```
