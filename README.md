# termai

A webterm designed for modern mobile.

Run the server on your Linux machine, connect from your phone over Tailscale, and dictate commands.
termai repairs dictation using your shell’s commands, files and history, with the original text available as an alternative.

<p>
  <img src="docs/images/example-git-init.png" width="250" alt="Mobile terminal and shortcut bar with alternatives correcting Get in it. to git init, with the original text still available.">
  <img src="docs/images/example-ls.png" width="250" alt="Mobile terminal and shortcut bar with alternatives offering ls -l and ls -L for LSL.">
  <img src="docs/images/example-python.png" width="250" alt="Mobile terminal and shortcut bar with alternatives resolving the spoken Python filename and myarg option to python3 hello_world.py --myarg food.">
</p>

termai integrates with [voxtype-mobile](https://github.com/nick1udwig/voxtype-mobile) if you don't have a dictation service.
Dictation runs alongside your server to maximize privacy and minimize latency.

termai integrates with [herdr](https://github.com/herdrdev/herdr) to provide a first-class agent experience on mobile.
Manage multiple agents via dictation.
Notifications when work is done.
Beautiful and fast.

## Install

After the first stable release has finished building, install the server and optionally set up Herdr, Voxtype Mobile and private Tailscale access with:

```sh
curl -fsSL https://github.com/nick1udwig/termai/releases/latest/download/install.sh | bash
```

The installer bundles the native Rust server and its setup runtime, and asks before installing a user service or optional companions.
See the [setup guide](docs/setup.md) for supported platforms, upgrade behavior and options.
Linux x86_64, Linux ARM64 and macOS Apple Silicon are release targets, with automatic Voxtype Mobile setup available on Linux.

## Build and run

Building from source requires **Rust 1.89+**, the **wasm32-unknown-unknown** target, **Node.js 22.18+**, a native C/C++ build toolchain, **Bash 4.4+**, **Python 3.8+**, and `base64`.
On macOS, install modern Bash with `brew install bash`.
The Rust server uses a native PTY, and the same Rust engine runs natively or as browser WebAssembly.

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:3000** and enter the **pairing token** printed at startup.
The token is saved and reused after restarts.
Every browser must pair, including on localhost.
Anyone with the token and network access can run commands as your host user.

The shell starts in the checkout directory.
Set `TERMAI_CWD=/path/to/project` to change it.
For development, use `npm run dev`.
Vite runs as a loopback frontend tool behind the Rust server's pairing gate, including authenticated hot reload.
Rust is the only backend, while Node supports frontend builds, installation tools and test fixtures.

## Connect from your phone

Sign in to Tailscale on your host and phone using the same tailnet.
Replace the hostname below with your host’s full Tailscale DNS name:

```sh
HOST=127.0.0.1 PORT=7321 TERMAI_ALLOWED_HOSTS=my-machine.tail1234.ts.net TERMAI_BASE_PATH=/termai npm start
```

In another terminal:

```sh
tailscale serve --bg --set-path=/termai http://127.0.0.1:7321
```

Follow any prompt to enable HTTPS, then open **https://my-machine.tail1234.ts.net/termai** on your phone and pair.
You can add it to your home screen.
Keep termai running; Tailscale Serve does not start it for you.

## Use it

- **Dictate commands** with your keyboard’s dictation or the built-in Voxtype Mobile integration.
  Review command alternatives before sending.
- **Open hosts** with **+**.
  Connect directly to termai backends or use SSH through a backend.
  Manage SSH keys in **Vault → Keychain**.
- **View Herdr sessions** with **Connect Herdr** in a host's menu, or by typing `herdr` in a local or SSH terminal.
- **Read files and output** with `look at README.md` or `git diff | look at`.
- **Transfer files** with `upload`, `download foo.py`, or **Connect SFTP / Files** in a host’s menu.
- **Customize** font size, shortcuts and input preferences in **Settings**.
- **Load plugins** in **Settings → Plugins** to add connection actions at runtime.
  Try the included [log viewer package](examples/plugins/example.log-viewer.termai-plugin.json).

## Documentation

- [Server setup](docs/setup.md): one-line installation, companions, Tailscale and user services.
- [Releases](docs/releases.md): native build checks, dependency pins and publishing.
- [Usage guide](docs/usage.md): connections, pairing, dictation, touch controls and file transfers.
- [Technical reference](docs/reference.md): shell integration, command repair, deployment and testing.
- [Herdr details](docs/herdr.md): sessions, mobile sizing and notifications.
- [Runtime plugin experiment](docs/plugins.md): loading packages, plugin API and connection lifetimes.
- [Workspace architecture](docs/workspace.md), [shared engine](docs/shared-engine.md), and [client architecture](docs/client-architecture.md).
- [Pairing security review](docs/pairing-security.md).
- [Rust migration](docs/rust-migration.md): contracts, active regression coverage and platform verification.

## License

[MIT](LICENSE).
Terminal rendering uses [ghostty-web](https://github.com/coder/ghostty-web) and [Ghostty](https://github.com/ghostty-org/ghostty); the bundled font is [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono).
See [third-party notices](public/THIRD-PARTY-NOTICES.txt) for their licenses.
Keep those notices with redistributed builds.
