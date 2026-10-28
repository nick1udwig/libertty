# Local source deployment

Use `scripts/deploy-local.mjs` to update an existing Linux systemd user service that runs a source checkout.
The base unit must run the `master` worktree's `target/release/libertty` directly.
Use the installer upgrade procedure in [setup.md](setup.md) for installed releases.

Create `.deploy.local.json` in the checkout that contains the script.
This file is ignored by Git because the URLs depend on the machine.
Set each URL to the application's root, including its mount path.

```json
{
  "service": "libertty.service",
  "urls": ["http://127.0.0.1:7321/t/", "https://your-host.example/t/"]
}
```

Select the Node version pinned in `build/release-config.json` before deployment.
Deploy the script's current worktree with:

```sh
node scripts/deploy-local.mjs
```

Build and deploy the existing `master` worktree with:

```sh
node scripts/deploy-local.mjs --master
```

Add `--dry-run` to inspect either plan without building or restarting the service.
The script does not switch, update or merge Git branches.
It runs `npm ci` and `npm run build:release`, then restarts the service and checks the release version and frontend assets at every configured URL.
It does not run tests or change Tailscale routes.
The restart ends live terminal connections and in-memory sessions.

Branch deployments set only `ExecStart` in the user service's `branch.conf` drop-in.
Master deployments remove that drop-in.
The service's working directory, environment and application data stay in place.
Keep a deployed worktree until the service returns to `master` or another worktree.
If deployment health fails, the script restores the previous service command and restarts it.
This restores service configuration only and does not restore build files replaced in the same checkout.
