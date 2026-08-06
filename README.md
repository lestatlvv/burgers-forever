# Burgers Forever — local development

Self-order kiosk Demo Store (Pan Oston / 4POS). This repo is a **Webflow site export** plus small local JS helpers so the kiosk flow works without Webflow CMS / Ecommerce hosting.

There is **no Node.js build step**, no `package.json`, and no TypeScript compile. Frontend work is plain HTML / CSS / JS. Use Node.js to serve the static files locally (or later for a companion Windows/background service).

## Prerequisites

- A modern browser (Chrome / Edge recommended for kiosk-like testing)
- **Node.js 18+** with `npx` (used to run `serve`)

No project `npm install` is required — `npx` fetches `serve` on demand.

## Project layout

```
burgers-forever.webflow/
├── index.html              # Attract / home screen
├── products.html           # Menu + cart (main kiosk screen)
├── thank-you.html          # Order complete
├── checkout.html           # Webflow checkout (not used by local demo flow)
├── paypal-checkout.html
├── order-confirmation.html
├── css/
│   ├── normalize.css
│   ├── webflow.css
│   ├── burgers-forever.webflow.css
│   └── keyboard-nav.css    # Local: keyboard focus styles
├── js/
│   ├── webflow.js          # Webflow runtime (Lottie, IX, etc.)
│   ├── demo-products.js    # Local: demo catalog + cart (no CMS)
│   ├── keyboard-nav.js     # Local: arrow-key spatial navigation + logical commands
│   ├── speech-engine.js    # Local: Kokoro/WebSpeech generate-at-start + cache
│   └── kiosk-guide.js      # Local: English phrases + movement announcements
├── images/                 # SVG / icons
└── documents/              # Lottie JSON animations
```

### Assistive speech

On each page load the guide builds the full English phrase list, asks `speech-engine.js` to synthesize every clip via the local Kokoro service (`http://127.0.0.1:7860`), caches WAVs in memory and IndexedDB, then plays from cache during navigation. If Kokoro is offline, `speechSynthesis` is used instead. See `../POC_NOTES.md`.

### Primary user flow (local demo)

1. `index.html` → **Press here to order**
2. `products.html` → add items (demo catalog) → open cart → **Finish purchase**
3. Optional print call to `http://127.0.0.1:8989/print` (fails quietly if no print tool)
4. `thank-you.html` → auto-returns to home after ~10s

Idle timeout on products: **4 minutes** → back to `index.html`.

## Run locally

Serve the **project root** (the folder that contains `index.html`) over HTTP. Do not open HTML files via `file://` — relative assets and some scripts will break.

### Default — Node.js (`serve`)

```bash
cd /path/to/burgers-forever.webflow
npx --yes serve -l 5500
```

Open: [http://127.0.0.1:5500/](http://127.0.0.1:5500/)

Stop with `Ctrl+C`.

### Alternative — Python

```bash
cd /path/to/burgers-forever.webflow
python3 -m http.server 5500 --bind 127.0.0.1
```

### Alternative — VS Code / Cursor Live Server

Use any Live Server extension pointed at the project root; use the URL it prints (often port `5500`).

## Verify it works

With the server running:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5500/index.html
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5500/products.html
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5500/js/demo-products.js
```

All should print `200`.

Manual smoke test:

1. Home shows Burgers Forever branding and **Press here to order**
2. Products page lists demo burgers / beer / wine (placeholder images)
3. Add items → cart quantity updates → open cart → change qty → **Finish purchase**
4. Thank-you page appears; keyboard arrows move a pink focus ring on interactive controls

### Viewport note

Designed for a **1080p portrait (9:16) kiosk**. In a landscape browser window the layout can look cut off. For realistic testing, use DevTools device mode, e.g. **1080 × 1920**, or resize the window to portrait.

## What to edit during development

| Goal | Files |
|------|--------|
| Demo menu items / prices | `js/demo-products.js` (`PRODUCTS`) |
| Arrow-key / Enter navigation | `js/keyboard-nav.js`, `css/keyboard-nav.css` |
| English audio guidance | `js/kiosk-guide.js`, `js/speech-engine.js` (+ Kokoro on `:7860`) |
| Layout / visual design | Prefer re-export from Webflow, or carefully edit HTML/CSS |
| Idle / thank-you timers | Inline `<script>` blocks in `products.html`, `thank-you.html` |
| Receipt print hook | Inline script in `products.html` (`#bon` → `127.0.0.1:8989/print`) |

Keep custom logic in the local `js/` / `css/` files when possible so a fresh Webflow export is easier to merge.

## Webflow re-export workflow

1. Export the site from Webflow (ZIP).
2. Replace exported HTML/CSS/`js/webflow.js` / assets carefully.
3. Re-apply (or keep) local overlays:
   - `js/demo-products.js` + script tag on `products.html`
   - `js/keyboard-nav.js` + `css/keyboard-nav.css` on relevant pages
   - `js/speech-engine.js` + `js/kiosk-guide.js` (+ `KIOSK_SPEECH` config) on home / products / thank-you
   - Print / idle timeout scripts if still required
4. Smoke-test the flow above.

Webflow CMS collections and Ecommerce cart **do not run** from a static export. That is why `demo-products.js` fills product cards and drives the cart locally.

## Optional: print test API

`products.html` calls `GET http://127.0.0.1:8989/print` before redirecting to thank-you. If that process is not running, the browser console shows a failed fetch; the redirect still happens. Start the Windows print test tool only when testing that integration.

## Out of scope for this folder

- Node/TypeScript app, bundler, or tests (not present)
- Storm EAA Pad audio guidance / Windows background service (separate trial scope)
- Live Webflow hosting / CMS / real payments

## Quick start (copy-paste)

```bash
cd burgers-forever.webflow
npx --yes serve -l 5500
# → http://127.0.0.1:5500/
```
