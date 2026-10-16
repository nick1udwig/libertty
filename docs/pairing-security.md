# Pairing security review

Tested on 2026-09-22 using disposable production and development servers, separate browser contexts, and synthetic private files and tokens.
Crash probes were run against disposable servers, never against the running user service.

## Findings and fixes

1.
  **Development file disclosure and conditional authentication bypass.** Before the fix, Vite served backend source and files inside the checkout without pairing.
  Placing `LIBERTTY_DATA_DIR` inside the checkout made its `pairing-token` readable through both a normal file URL and `/@fs/...?raw` requests.
  That token could then grant terminal access.
  Vite's rejected filesystem requests also revealed absolute paths.
  Production did not expose these files in the tested configuration.
  Development now serves a small pairing page before allowing access to any Vite assets or middleware.
  Its hot reload WebSocket transport also requires authentication, Host validation, and Origin validation.

2.
  **Unauthenticated server crash.** A WebSocket upgrade with the request target `//[` caused an uncaught URL parsing exception and terminated the production server.
  Invalid upgrade URLs are now caught and their connections closed.

3.
  **Blank terminal after pairing elsewhere.** Cancelling the initial pairing dialog, then pairing from Backends, left the existing terminal waiting for credentials.
  Successful pairing now sends credentials to every waiting frame for that backend.
  A delayed rejection from a frame cannot discard newer credentials.
  The existing frame reconnects without opening a replacement tab.

## Checks

- Missing, incorrect, malformed, and forged credentials; same-origin access on localhost; approved and unapproved cross-origin requests.
- All current API routes using GET, POST, PUT, DELETE, and HEAD, including shell creation, command suggestions, environment facts, key export, SSH probes, and WebSocket ticket issuance.
  Unauthenticated attempts receive 401 or 403.
- Backend source, private files, token files, traversal, malformed escapes, `/@fs`, and development client routes.
  Responses contain no fixture secrets, host account data, or absolute checkout paths.
- Terminal sockets, fake tickets, malformed upgrades, and development sockets with and without an Origin header.
  No unauthenticated connection succeeds; the server remains responsive.
  Probes create no shell sessions.
- Successful pairing, cookie and bearer reconnects, existing session isolation and single-use ticket checks, wrong-token UI feedback, and the cancelled-dialog recovery described above.
- Development pairing under a URL prefix, a working terminal after pairing, and authenticated hot reload in Chromium.

Run `npm test`, `npm run test:workspace`, and `npm run test:pairing` after building with `npm run build`.
These tests need permission to listen on localhost.

Validation passed: build, 87 automated tests, workspace and terminal browser suites, and the development pairing browser check.
After restarting the user service, 14 live probes returned 401 for protected APIs and 404 for private file paths.
The live frontend served the current build.
These live checks used the local proxy upstream with the configured public Host and Origin headers.

## Scope and remaining boundaries

After these fixes, the probes found no unauthenticated route to terminal access, shell state, history, environment facts, SSH keys, or private host files.
Production intentionally serves the frontend, fonts, WebAssembly, and license notices before pairing; these reveal application code and dependency information.

Generated pairing tokens contain 256 random bits and are saved with mode 0600.
An explicitly configured token must be random as documented: its length check does not guarantee entropy.
There is no dedicated pairing attempt rate limiter.

Pairing issues separate bearer credentials and a session cookie.
Possession of either still permits access without entering the pairing token again.
Protect the paired browser, the server account, token file, and startup logs.
Issued credentials survive restarts.
The backend persists only their hashes in `paired-clients.json` with mode 0600; the browser saves credentials per backend URL in local storage and uses a persistent HttpOnly cookie for same-origin access.
Changing the pairing code and restarting, or removing the registry while the backend is stopped, revokes saved pairings.
TLS, such as Tailscale Serve's HTTPS endpoint, is required to protect credentials over an untrusted network.

This is a targeted code review and regression test set, not a proof against all vulnerabilities.
It does not audit the reverse proxy, operating system, all dependency internals, compromised browser extensions, or general traffic flooding.
