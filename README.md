# Open in Web Viewer

Obsidian plugin for `.html`, `.htm` and `.json`. Version **1.2.0** integrates a Style HTML Viewer–based mobile reader while keeping the desktop Web Viewer path.

## Mobile: document first

- **Scripts run automatically** in HTML previews. There is no per-document opt-in checkbox. Open only documents and dependencies you trust.
- A **48 px toolbar** offers Search, Reload and More. Source, heading navigation, Print / save PDF and diagnostics open on demand instead of occupying permanent rows. Search replaces the same row; menus and sheets overlay the document.
- No duplicate plugin actions are added to Obsidian's native mobile header. Native app chrome is not hidden or restyled.
- Relative links use Obsidian's workspace. Hash-only links such as `#codigo` scroll **inside the document**, rather than letting `srcdoc` resolve them against the host app's URL and replace the preview.
- Inline and local scripts, stylesheets, CSS imports/URLs, images, fonts and `srcset` are processed by the adapted Style asset engine/PostCSS. Authored themes override the readable light default for unstyled documents.
- JSON is parsed into an escaped tree, never evaluated as JavaScript.
- Vault dependency changes refresh the preview; unload/close/newer renders invalidate obsolete work and bridge messages.

### Isolation and limits

The iframe uses `sandbox="allow-scripts allow-modals"` (modals allow printing), **without `allow-same-origin`**, forms, popups or top navigation. It receives no Node/Electron, vault adapter or parent DOM access. The host inserts its own CSP before authored scripts, removes base/refresh/CSP overrides and nested active content, and validates bridge source and a per-render token.

Mobile resources are local/embedded only. Remote stylesheets, fonts and scripts (including Google Fonts/CDNs), runtime fetch/XHR, Workers and nested frames are blocked. Specific diagnostics are available from More; they do not expand over the reader automatically. This isolation does not make malicious JavaScript harmless: it can hang its preview, and CSP does not prevent a script from navigating its own iframe to a remote page. It is **not a network/privacy boundary**. Document messages never automatically open external host windows; external URLs are shown for manual handling. Desktop uses a different, less restricted browsing environment.

An opaque iframe cannot use native `localStorage` or `sessionStorage`. A Storage-compatible **in-memory fallback** is installed before document scripts. Theme/progress works while that rendered document stays open, but **does not persist across reload, navigation or reopening**. The first use reports this limitation in diagnostics; the stores are never bridged to Obsidian's own storage.

Local asset loading rejects hidden/configuration paths and unsupported file types before reads. It reserves recorded sizes before asset reads, with a **10 MiB aggregate asset budget** and **256-asset limit** per render. The main HTML read is separate and has its own text-size check; these limits are not a general JavaScript/DOM memory quota. Module files with further imports are not bundled: export self-contained HTML/classic scripts instead.

## Desktop

Starts a loopback HTTP server at `http://127.0.0.1:<random-port>/…` and opens the file in Obsidian's core **Web Viewer**. Enable that core plugin first. The `webviewer` view type is an internal Obsidian API, not a stable public contract.

The server binds to IPv4 loopback, encodes each filename segment (including literal `#`, `?`, `%`, spaces and accents), and checks decoded/real paths for traversal, hidden segments and symlink escapes. Node built-ins are loaded lazily on the desktop path, not during mobile module evaluation.

## Requirements and installation

- Obsidian **1.8.3+**.
- Desktop: core **Web Viewer** enabled.

Build, then copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/open-in-webviewer/`, preserving existing configuration. Keep the plugin and third-party licenses with redistributed packages. Enable **Open in Web Viewer**. Do not enable a second plugin that claims the same `.html` extension in that vault.

The feature branch is not a production deployment. Chromium/SDK-seam tests do **not** certify iOS WKWebView, Android or the native Obsidian shell; validate the candidate in a separate vault before replacing a working installation.

## Development and verification

```bash
npm ci --ignore-scripts
npm run dev
npm test
npm run typecheck
npm run build
```

`npm test` compiles pure modules and runs Node tests plus real headless Chromium/CDP tests through the **actual plugin entry and registered view factory**, using a synthetic Obsidian API seam. A recent Node with built-in WebSocket and Chromium are required. Set `BROWSER_EXECUTABLE` or `CHROMIUM` if it is not `/usr/sbin/chromium`.

Browser profiles, generated bundles, logs and screenshots stay under ignored `.test-runtime/`; personal browser profiles are never used. Chromium's OS sandbox remains enabled. Browser source-harness tests target ES2020; shipping bundles target ES2018 and are minified for production. Separate shipping-bundle module-load tests reject eager Node/Electron dependencies. `typecheck` uses `--skipLibCheck` for the SDK declarations.

## Attribution and license

MIT. Mobile rendering reuses the resolver, PostCSS processing, IPC and preview lifecycle from [taihoe/style-html-viewer](https://github.com/taihoe/style-html-viewer), version **1.0.6**, commit `708c18c7518d72ac7917f85fbe03c466652263a9`.

The upstream [MIT license](src/vendor/style-html-viewer/LICENSE) is preserved. [NOTICE.md](src/vendor/style-html-viewer/NOTICE.md) records local adaptations. Test documents in this repository are synthetic; personal class recaps are not included.
