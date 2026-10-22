# Install and set up libertty

## Install a release

The release installer bundles the native Rust executable, built frontend and a Node runtime for setup tools, so you do not need npm or a compiler on the server.
The command below becomes available after the first release built by the [release workflow](../.github/workflows/release.yml) has finished publishing its assets.

```sh
curl -fsSL https://github.com/nick1udwig/libertty/releases/latest/download/install.sh | bash
```

Run it as the account that should own your terminals, files and services.
The installer verifies the downloaded archive against its release checksum before executing the bundled runtime.
Interactive questions read from your terminal, so they still work when the script is piped into Bash.

## What setup does

1. Download the matching release and install it in your user data directory.
2. Check Bash and Python, offering to install missing Python and modern Bash on macOS through your package manager.
3. Offer to start a systemd user service on Linux or a login LaunchAgent on macOS.
4. On Linux, offer to enable user lingering so services start at boot and survive logout.
5. Offer to install Herdr if its executable is missing.
6. Detect a compatible Voxtype Mobile dictation API and offer to install or upgrade the Linux daemon if it is unavailable.
7. Offer to install Tailscale if it is missing, then connect it and configure private HTTPS access.
8. Verify the running release and print its URL, pairing token and companion setup results.

Accept the defaults to set up everything supported on your machine.
Package installation and Linux Tailscale setup can require your sudo password.
Tailscale login and enabling tailnet HTTPS can require following a browser link printed by the CLI.
These approvals cannot be completed automatically by libertty.
Install Tailscale on your phone, join the same tailnet, open the printed URL and enter the pairing token.

## Supported machines

| Release target | Requirements | Background service | Automatic companions |
| --- | --- | --- | --- |
| Linux x86_64 | glibc 2.39 or newer, Bash 4.4+, Python 3.8+ | systemd user service | Herdr and Voxtype Mobile |
| Linux ARM64 | glibc 2.39 or newer, Bash 4.4+, Python 3.8+ | systemd user service | Herdr and Voxtype Mobile |
| macOS Apple Silicon | macOS 15+, Homebrew, Bash 4.4+, Python 3.8+ | Login LaunchAgent | Herdr |

Linux bundles are built on Ubuntu 24.04, while the installer checks the Voxtype dependencies separately.
The pinned dictation engine uses ONNX Runtime binaries that require newer glibc symbols than Ubuntu 22.04 provides.
The bootstrap rejects older or non-glibc Linux systems before downloading or executing a bundle.
Voxtype Mobile needs Python 3.11+, the Opus runtime and ALSA, and a fresh installation downloads a speech model of roughly 1 GB.
On distributions whose default Python is older than 3.11, install a newer Python on your PATH before enabling Voxtype Mobile.
The installer supports apt, pacman and dnf for Linux runtime packages.
Other package managers require those packages to be installed beforehand.
Alpine Linux, 32-bit ARM, Windows and Intel Macs are not release targets.

Apple Silicon builds must pass the same packaged PTY and installation checks in CI before any assets are published.
Use the macOS installer from a logged-in desktop session so the LaunchAgent can start in your GUI domain.
Its service starts at login rather than before login.
Automatic Voxtype Mobile setup is currently Linux-only, although a separately configured compatible local daemon can still be detected on macOS.

If Linux has no systemd user manager, setup installs a launcher and prints the command to start it manually.

## Tailscale setup

libertty listens on `127.0.0.1:7321` with the `/t` mount by default.
Setup adds your machine's tailnet DNS name to libertty's allowed hosts and uses this scoped Serve command:

```sh
tailscale serve --bg --https=443 --set-path=/t http://127.0.0.1:7321
```

On Linux, setup uses sudo for Tailscale configuration without granting the account permanent operator permissions.
The installer leaves existing routes in place and reuses an identical route on subsequent runs.
If `/t` already serves another application, choose a different `--base-path` or change that route yourself.
It refuses to add libertty to an HTTPS listener with public Funnel exposure enabled.
If new Serve setup fails, it restores libertty's previous allowed hosts and removes only the route it added.

When Voxtype Mobile is ready, setup also offers an Android app endpoint at `wss://YOUR-HOST.ts.net/voxtype/v1/dictate`.
It prints the daemon's token file for pairing the Android app.
libertty's built-in dictation connects directly to the local daemon and does not require that extra Serve route.
Existing incompatible or custom Voxtype services may require manual migration, with the upstream installer refusing unexpected service commands.

## Options and unattended installation

To inspect the script before running it:

```sh
curl -fsSL https://github.com/nick1udwig/libertty/releases/latest/download/install.sh -o /tmp/libertty-install.sh
less /tmp/libertty-install.sh
bash /tmp/libertty-install.sh
```

To select a release, including a prerelease:

```sh
bash /tmp/libertty-install.sh --version v0.2.11
```

To change the port and mount:

```sh
bash /tmp/libertty-install.sh --port 7400 --base-path /terminal
```

To install only libertty without companion, service or Tailscale setup:

```sh
bash /tmp/libertty-install.sh --yes --no-service --no-companions --no-tailscale
~/.local/bin/libertty
```

`--yes` accepts all installer questions and can start services or install system packages unless you exclude those steps.
It does not bypass sudo authentication or Tailscale login.
`--no-service` applies to the libertty service, so also use `--no-companions` to avoid creating a Voxtype service.
`--prefix /absolute/path` changes where versioned application releases and the launcher are installed.
`XDG_CONFIG_HOME` and `XDG_DATA_HOME` select the configuration and user data roots.

For a downloaded or locally built archive, supply its SHA-256 digest explicitly:

```sh
bash install.sh --archive release/libertty-v0.2.11-linux-x64.tar.gz --sha256 YOUR_SHA256 --no-companions --no-tailscale
```

## Configuration, upgrades and troubleshooting

| Default path | Purpose |
| --- | --- |
| `~/.local/bin/libertty` | Launcher available to shells with `~/.local/bin` on PATH |
| `~/.config/libertty/config.json` | Private managed server environment |
| `~/.local/share/libertty/releases/` | Versioned application bundles |
| `~/.local/share/libertty/current` | Active release symlink |
| `~/.local/share/libertty/pairing-token` | Browser pairing token |
| `~/.local/share/libertty/setup-status.json` | Last optional setup results |
| `~/.config/systemd/user/libertty.service` | Linux user service |
| `~/Library/LaunchAgents/com.libertty.server.plist` | macOS login service |

Rerun the one-liner to upgrade to the latest stable release or retry unfinished optional setup.
Upgrades preserve the pairing token, application data and existing managed environment settings.
An explicit port or mount option replaces that setting for the new installation.
Previous releases remain on disk and are restored automatically if the new service fails its startup check.
An existing unmanaged libertty service or launcher requires explicit migration before the installer will replace it.
Restarting libertty ends live terminal connections, and interactive upgrades ask before restarting an active service.
Optional setup failures leave libertty installed, report the failing step and return exit code 2.

Edit `config.json` to change server environment variables, then restart the service.
Keep the configuration and token files private.

```sh
~/.local/bin/libertty --version
systemctl --user status libertty.service
journalctl --user -u libertty.service -n 80
systemctl --user restart libertty.service
systemctl --user status voxtype.service
tailscale serve status
```

On macOS, inspect `~/.local/share/libertty/server.log` and restart with:

```sh
launchctl kickstart -k "gui/$(id -u)/com.libertty.server"
```

The unauthenticated `/t/healthz` endpoint reports only release metadata for readiness checks.
Browser pairing remains required for terminal access.
