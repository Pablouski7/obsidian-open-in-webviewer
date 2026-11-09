# Vendored: Style HTML Viewer

This directory contains a modified copy of **taihoe/style-html-viewer**, an Obsidian plugin by Tan Tai Hoe,
licensed under the MIT License (see `LICENSE` in this directory, the original upstream text).

- Upstream: https://github.com/taihoe/style-html-viewer
- Version: v1.0.6
- Commit: `708c18c7518d72ac7917f85fbe03c466652263a9`
- Original copyright and license notice retained unchanged in `LICENSE`.

Logic unchanged from upstream: `src/engine/css.ts` (PostCSS-based stylesheet engine), `src/engine/paths.ts`,
`src/watcher/VaultWatcher.ts` (trailing blank lines normalized).

The upstream plugin entry (`src/main.ts`, which registered its own `html-viewer-view` type and the Markdown
`html-viewer` code block) and `src/styles.d.ts` are not included. This plugin has its own entry (`/main.ts`) and
keeps a single handler for `.html`/`.htm`/`.json` under its existing view id `open-in-webviewer-mobile`.

## Local adaptations

Every changed place in the source is marked `LOCAL`.

| File | Change | Why |
|---|---|---|
| `src/engine/HtmlAssetResolver.ts` | `allowScripts` defaults to **true**; new option `initialFragment`. | The mobile reader always runs document scripts (inside the sandbox and CSP). |
| | Local `<script src>` is **inlined** as text (with `</script`/`<!--` escaped) instead of rewritten to a `data:` URL; `defer` is reproduced by moving the script to the end of `<body>`. | Browsers mute errors from cross-origin scripts as "Script error."; a `data:` script is cross-origin to its document. Inlining keeps message, file and line. |
| | A `<style>:root{color-scheme:light}</style>` is inserted right after the bridge, before authored CSS. | Readable light default; authored themes override. |
| | Clearer "remote resource blocked" diagnostics; new diagnostic kind `notice`. | Specific, actionable messages. |
| `src/ipc/IpcBridge.ts` | Hash-only link clicks (`#`, `#id`, percent-encoded ids, `name=` anchors) are **completed inside the document** instead of being left to the browser. | A srcdoc document's base URL is the host page, so the browser navigates the frame to the host URL: the frame goes blank. |
| | Storage fallback script runs first (see `StorageShim.ts`). | Opaque-origin `localStorage`/`sessionStorage` throw `SecurityError`. |
| | Error reporting keeps file/line and explains muted errors; `unhandledrejection` is reported; navigation reports the target fragment through `onNavigate`; the stylesheet import is replaced by a constant holding only the search-highlight rules. | Useful diagnostics, `page.html#section` links, no desktop CSS inside the document. |
| `src/ipc/StorageShim.ts` | **New file.** In-memory `Storage` replacement for `localStorage`/`sessionStorage` when unusable. | Not persisted; reported once in diagnostics. |
| `src/preview/PreviewPanel.ts` | Compact single-row reader chrome and on-demand overlays instead of the multi-row control panel; no script checkbox/preference; JSON documents use the same pipeline; no viewport-width simulator. | Phone-sized reader. |
| `src/preview/VaultResources.ts` | Hidden-path and file-type allowlists enforced **before** any vault read; per-render budget (10 MiB total, 10 MiB per file, 256 assets) spent from `stat.size` before reading. | Restricted local access, bounded memory. |
| `src/view/HtmlView.ts` | Abstract base without header actions, script preferences or fixed view id. | No duplicate native header actions on mobile. |
| `styles.css` | Replaced by the compact chrome stylesheet (scoped to `.html-viewer-container`). | See above. |

### Review hardening

- `HtmlAssetResolver`: per-occurrence emitted-output budget (16 MiB characters by default), including repeated data URLs, stylesheet imports and script text; reserve the viewer's own script before optional assets.
- `IpcBridge`: admit existing non-hidden HTML/HTM/JSON files only, open `TFile` via the leaf rather than creating unresolved notes; limit requests to 30 navigations / 3 new tabs per rendered frame. Same-file fragments stay local. Empty/whitespace and SVG `xlink:href` links are intercepted too.
- External URLs produce a Notice for manual handling, never an automatic host-window opening. Diagnostics do not claim network isolation: a trusted document script can still navigate its own iframe.
- `PreviewPanel`: recorded main-file size is checked before reading; the actual text is checked afterwards. Fragment queues are bounded and consumed.
- `VaultResources`: require real file extensions and valid size metadata, reject custom configuration directories, use a separate binary MIME allowlist and recheck actual data after reads.
- The surrounding plugin's desktop server rejects decoded NUL/control characters before filesystem operations.
