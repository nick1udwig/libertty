---
name: termai-ops
description: Operate Termai from this repository, including local source deployment, the existing systemd and Tailscale setup, version bumps, and release packaging.
---

# Termai operations

Run commands from the repository root and follow the work order and validation routing in [AGENTS.md](../../../AGENTS.md).
Read [README.md](../../../README.md) for source prerequisites and the basic build and phone connection setup.
Use [docs/setup.md](../../../docs/setup.md) for installed release upgrades and [docs/releases.md](../../../docs/releases.md) for packaging and publication.
For a version bump, read [references/version-bumps.md](references/version-bumps.md).
For deploy or push requests, apply the testing exception in [AGENTS.md](../../../AGENTS.md) throughout the request, including preparatory work.

## Existing local deployment

The Linux user service is `termai.service`; inspect its startup command to determine whether it runs this checkout's `target/release/termai` or the launcher installed by `./install.sh`.
It listens on `127.0.0.1:7321`, mounts at `/t`, and allows `127.0.0.1`, `localhost`, and `omafwchy.taila510b.ts.net`.
The phone URL is `https://omafwchy.taila510b.ts.net/t/` on the tailnet.
Confirm the active service and route before deployment because the unit or installation mode may have changed.

```sh
systemctl --user show termai.service --property=FragmentPath --property=ExecStart --property=WorkingDirectory --property=ActiveState
tailscale serve status
```

Use the Node version pinned in `build/release-config.json` and run deployment tests only when the user explicitly requests them.
If the service runs this checkout's `target/release/termai`, rebuild the optimized native server and frontend before restarting it.
For an installer-managed service, use the installed release upgrade procedure below instead.
`npm run build` builds a debug backend and does not update `target/release/termai`.
Restarting ends live terminal connections and in-memory sessions.

```sh
npm ci
npm run build:release
systemctl --user restart termai.service
systemctl --user status termai.service --no-pager
journalctl --user -u termai.service -n 80 --no-pager
curl -fsS http://127.0.0.1:7321/t/healthz
curl -fsS https://omafwchy.taila510b.ts.net/t/healthz
```

Check that both health responses report `ok: true` and the expected version from `package.json`.
Open the phone URL, pair if needed, and verify that the frontend loads and a terminal connects.
Read the pairing token locally from the startup journal or the configured data directory without committing or publishing it.
The default token location is `~/.local/share/termai/pairing-token`.

Tailscale Serve strips the `/t` prefix, which Termai supports with `TERMAI_BASE_PATH=/t`.
Keep the existing `/`, `/tern`, `/codey`, and `/voxtype` routes intact.
For this deployment, the scoped route command is:

```sh
tailscale serve --bg --set-path=/t http://127.0.0.1:7321
```

Only change the route when the deployment needs it, after inspecting `tailscale serve status`.

## Run from source on another host

Install the source prerequisites listed in the README and select the pinned Node version before installing dependencies.
Use these commands for the README's source build and phone connection setup.

```sh
npm ci
npm run build
HOST=127.0.0.1 PORT=7321 TERMAI_ALLOWED_HOSTS=my-machine.tail1234.ts.net TERMAI_BASE_PATH=/termai npm start
```

Replace the example hostname with the host's full Tailscale DNS name and sign in on the host and phone using the same tailnet.
In another terminal, add the corresponding scoped route:

```sh
tailscale serve --bg --set-path=/termai http://127.0.0.1:7321
```

Open `https://my-machine.tail1234.ts.net/termai` and enter the pairing token printed at startup.
Tailscale Serve does not start or supervise Termai, so keep `npm start` running or configure a service.
Use `TERMAI_CWD=/path/to/project` to choose the initial shell directory and `npm run dev` for authenticated frontend hot reload.

## Installed releases and packaging

Inspect `ExecStart` before choosing an upgrade path because an installer-managed service uses its installed release rather than this checkout's binary.
For a setup installed with `./install.sh`, upgrade through the same installer so its launcher, release metadata, active release symlink, and rollback behavior stay consistent.
Reuse its existing `--prefix`, `XDG_CONFIG_HOME`, and `XDG_DATA_HOME` settings when customized.
Preserve its service or manual-launch mode, adding `--no-service` when the installation has no managed service.
The installer preserves the existing server environment, pairing token, and application data, except for port or mount settings explicitly overridden by installer options.
Run the checkout's installer with Bash.
To update only Termai to the latest published stable release without reconfiguring companions or Tailscale, run:

```sh
bash ./install.sh --no-companions --no-tailscale
```

To deploy local code changes to an installer-managed service, build a local archive using the release guide, then install that archive with its SHA-256 checksum.
Run the archive's test suites only when the user explicitly requests tests.
Replace `VERSION`, `PLATFORM`, and `SHA256` below with the verified archive's values and add any existing custom installation settings.

```sh
bash ./install.sh --archive release/termai-vVERSION-PLATFORM.tar.gz --sha256 SHA256 --no-companions --no-tailscale
```

A checkout rebuild alone does not update an installed release, so do not overwrite installed binaries or repoint the service at `target/release/termai`.
After installation, check the configured port and mount for readiness and compare the health response with the installed release metadata.
Follow the setup guide for installer-managed Linux services, macOS LaunchAgents, and manual launchers.
Do not replace an existing checkout service with the installer unless migrating that deployment is part of the request.
For a distributable Linux archive, use the pinned Voxtype Mobile checkout and daemon described in the release guide.
`TERMAI_RELEASE_ALLOW_DIRTY=1` permits development packages without the companion daemon and must not be used for published releases.
Run the package checks required by AGENTS.md before committing packaging changes, applying its deploy or push testing exception.
Creating or updating operational documentation does not authorize restarting services, changing routes, or publishing releases.
