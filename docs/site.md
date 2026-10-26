# Project site

The project site in `site/` is a landing page around a working demo of libertty.
On desktop the page shows a phone whose screen runs the real app, with sections below that explain the features, setup steps and platforms and link to the guides.
On a phone the page opens on the headline, a summary, the install command and the features, followed by the full product sections and guides.
The demo button scrolls to the swipe area after those sections.
Swiping through that area raises the app as a card over the page, and when the card reaches the top it becomes the full-screen app.
Scrolling up then stays inside the app, and Back returns to the landing page.
Phones load the app after the landing page, or as soon as the visitor starts the swipe, and `#demo` opens the app directly.
The page follows the system appearance, using the 1776 theme in dark mode and the flag theme in light mode.

## Build and preview

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build:site
npx vite preview --config site/vite.config.ts
```

`npm run dev:site` serves the same pages with hot reload, with the landing page at `/`, the guides at `/setup/` and beside it, and the app at `/app.html`.
The build writes a static site to `dist-site/` that any static host can serve.
Set `LIBERTTY_SITE_BASE=/path/` when the site is not served from the root of its domain.
Run `npm run test:site` to build the site and check mobile content, navigation and demo entry in Chromium.

## Guides

`site/pages.ts` renders the user-facing guides in `docs/` into `/setup/`, `/usage/`, `/herdr/` and `/reference/`, using the template in `site/page.html`.
Headings keep GitHub's anchors, links between published guides stay on the site, and other repository links go to GitHub.
Add a guide by listing its file, slug, label and search description in `pages`.

## Search and sharing

Set `LIBERTTY_SITE_URL` to the landing page's public address, which defaults to `https://libertty.sh/`.
The build uses it for the canonical links, Open Graph and structured data, `sitemap.xml` and `robots.txt`.
Crawlers only read `robots.txt` at the root of a domain, so publish it there when `LIBERTTY_SITE_BASE` is not `/`.
`robots.txt` keeps crawlers out of the repository snapshot, and `app.html` and `terminal.html` carry `noindex`, so only the landing page and the guides are indexed.
`site/social.png` is the 1200 × 630 link preview, a dark-mode screenshot of the landing page.
Retake it when the landing page changes visibly.

## How the demo works

The workspace and terminal documents are the app's own `index.html` and `terminal.html`, built with demo entries that run first.
`site/demo/boot-app.ts` seeds a fresh workspace on every visit with a terminal, Herdr, files and a reader, and installs an in-page backend.
The app opens on the terminal, and the reader shows the README last.
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
