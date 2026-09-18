# Open in Web Viewer

Obsidian plugin that opens `.html`, `.htm`, and `.json` files in Obsidian's
core **Web Viewer** plugin instead of the default file view — so HTML files
with JavaScript actually execute (canvas/D3/WebGL visualizations, SPA-style
docs, etc.) and JSON files get Chromium's built-in collapsible tree viewer.

## Why

Obsidian doesn't render JavaScript for local `.html` files by default, and
other HTML-viewing plugins typically show static markup only. Obsidian's
built-in Web Viewer (the `webviewer` core plugin) uses a real Electron
webview capable of running JS like a normal browser, but it only has a UI
for opening external links — not local vault files. This plugin bridges
that gap.

## Requirements

- **Desktop only** (Web Viewer has no webview on mobile).
- Obsidian **1.8.3+**.
- The core **Web Viewer** plugin must be enabled (Settings → Core plugins →
  Web viewer).

## What it does

- Registers `.html`, `.htm`, and `.json` as default-open extensions: clicking
  one of these files in the vault opens it in a new Web Viewer tab instead of
  Obsidian's normal file view.
- Adds an **"Open in Web Viewer"** item to the file context menu for these
  extensions.
- Adds a command, **"Open current file in Web Viewer"**, for the currently
  active file.

## How it works

Obsidian's core Web Viewer doesn't expose a public/documented API for other
plugins to open a URL in it. This plugin relies on the same internal
mechanism the Obsidian team confirmed in their developer forum for
programmatically opening a Web Viewer tab:

```ts
const leaf = app.workspace.getLeaf("tab");
await leaf.setViewState({
	type: "webviewer",
	state: { url: fileUrl, navigate: true },
	active: true,
});
```

`fileUrl` is a `file://` URL built from the vault's absolute path plus the
file's vault-relative path.

**Caveat:** the `webviewer` view type is an internal implementation detail of
Obsidian's core plugin, not a stable public API. It works as of Obsidian
1.13.x but could change without notice in future Obsidian releases.

## Installation (manual)

1. Clone or download this repo into
   `<your-vault>/.obsidian/plugins/open-in-webviewer/`.
2. `npm install`
3. `npm run build`
4. Enable **Open in Web Viewer** in Settings → Community plugins.

## Development

```bash
npm install
npm run dev   # watch mode
```

## License

MIT
