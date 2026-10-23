# Project site

The project site in `site/` is a landing page around a working demo of libertty.
On desktop the page shows a phone whose screen runs the real app, and on a phone the page is only the app.
The page follows the system appearance, using the 1776 theme in dark mode and the flag theme in light mode.

## Build and preview

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build:site
npx vite preview --config site/vite.config.ts
```

`npm run dev:site` serves the same pages with hot reload, with the landing page at `/` and the app at `/app.html`.
The build writes a static site to `dist-site/` that any static host can serve.
Set `LIBERTTY_SITE_BASE=/path/` when the site is not served from the root of its domain.

## Link previews

The landing page includes Open Graph and Twitter card metadata in its HTML so link previews do not need JavaScript.
Set `LIBERTTY_SITE_URL` to the public landing page URL, which defaults to `https://libertty.sh/`.
Use an absolute HTTP(S) URL without credentials, a query or a fragment.
The build adds a trailing slash if needed.
For a site under `/path/`, set both `LIBERTTY_SITE_BASE=/path/` and `LIBERTTY_SITE_URL=https://example.com/path/`.
The build copies `site/social.png` to `dist-site/social.png` and uses its absolute public URL in the preview metadata.
The image is a 1200 × 630 screenshot of the landing page in dark mode.
Retake it when the landing page changes visibly.

## How the demo works

The workspace and terminal documents are the app's own `index.html` and `terminal.html`, built with demo entries that run first.
`site/demo/boot-app.ts` seeds a fresh workspace on every visit with a terminal, Herdr, files and a reader, and installs an in-page backend.
On desktops the reader shows the README last, and on phones it opens first on `site/welcome.md`, which repeats the landing page.
Terminal and Herdr pane frames reach that backend through `site/demo/shim.ts`, which replaces `fetch` and `WebSocket` for backend URLs only.
Everything the visitor sees and touches inside the phone is the real frontend.

The backend answers the HTTP routes and JSON WebSocket messages the app uses, in `site/demo/server.ts`.
`site/demo/shell.ts` and `site/demo/commands.ts` provide a small shell over a snapshot of the tracked repository, with a pager and a minimal vi in `site/demo/programs.ts`.
Typed repairs and dictation alternatives run the backend's own engine code through `crates/engine-wasm`.
Dictation records the same microphone stream the app captures and shows levels for, and Whisper transcribes it in a Web Worker in place of Voxtype.
The `whisper-tiny.en` model, about 41 MB, downloads from Hugging Face on the first dictation, with transformers.js loaded from jsDelivr.
`site/demo/herdr.ts` scripts Herdr agents modeled on libertty's own development, including a permission prompt the visitor can answer.
Files the visitor edits or uploads last until the page reloads.

## Install address

The landing page's one-liner uses `https://install.libertty.sh`.
Point that address at a redirect to `https://github.com/nick1udwig/libertty/releases/latest/download/install.sh`, which `curl -L` follows to the latest release's installer.
