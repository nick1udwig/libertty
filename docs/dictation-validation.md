# Dictation capture and screen wake validation

libertty requests a screen wake lock for every recording because background microphone capture cannot be assumed reliable across mobile browsers.
The [Screen Wake Lock specification](https://www.w3.org/TR/screen-wake-lock/) restricts acquisition to visible, eligible documents and allows denial or automatic release.
Embedded ordinary terminals and Herdr panes request from the same-origin outer document, falling back to their own document for other embeds with delegated permissions.
This prevents automatic screen timeout where supported and permitted, but cannot override an explicit device lock.

## Deployment checks

On 2026-10-18, a deleted development worktree left `libertty.service` running with no frontend files.
The health API still returned `ok: true`, while `/t/dictation-worklet.js` returned HTTP 404.
Rebuild an existing checkout and remove the stale branch override before restarting the service.
The restart ends live standalone terminal sessions.
Check the worklet URL locally and through the phone's HTTPS route.
Both checks must return JavaScript with HTTP 200.

## Automated results

Run `node --test test/dictation-wake-lock.test.ts`, `node test/dictation-browser.mjs`, and `node test/herdr-browser.mjs` after building.
The unit coverage checks acquisition, finish and cancellation cleanup, hidden-document release, visibility restoration, denial, missing API support, unexpected release, teardown and pending-acquisition races.
Headless Chromium uses fake microphone audio and an isolated Voxtype-compatible daemon to verify sequenced Opus transport through simulated visibility loss, microphone permission failure, paused AudioContext recovery and ended-track cleanup.
The Herdr regression checks that the outer page owns the wake lock and that hiding the page preserves the recording pane and its audio transport.
These checks verify application lifecycle behavior, not real operating-system screen locking or speech recognition quality.

## Real-device results

No physical phone or mobile browser session was available in this development environment on 2026-10-12, so no real-device locked-screen capture result is claimed.

| Platform and mode | Automatic timeout | Explicit lock | Actual audio and transcript |
| --- | --- | --- | --- |
| Android Chrome, browser tab | Not run | Not run | Unverified |
| Android Chrome, installed web app | Not run | Not run | Unverified |
| iOS Safari, browser tab | Not run | Not run | Unverified |
| iOS Safari, installed web app | Not run | Not run | Unverified |

For each device, record its model, OS version, browser version, installed mode, power-saving settings, duration, wake lock outcome, decoded audio and transcript result.
Use a real microphone and recognizer over HTTPS, and speak distinct phrases before, during and after automatic screen timeout, then repeat with an explicit lock.
Compare the decoded daemon audio and final transcript with those phrases; a microphone indicator alone does not establish successful capture.
Repeat in a standalone terminal, embedded ordinary terminal, Herdr pane and SSH-backed input target, then check finish, cancel and switching away from the recording terminal.
The fallback passes when the visible recording prevents automatic timeout and ending it restores normal timeout behavior.
For explicit lock, report uninterrupted capture only if both the recorded audio and transcript contain the speech spoken while the screen was off.
Record any pauses or missing speech as unsupported locked-screen capture for that configuration.
