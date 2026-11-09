/**
 * Open in Web Viewer — plugin entry point.
 *
 * Desktop: starts a loopback HTTP server and opens files in Obsidian's core
 *          webviewer using an http:// URL (Node modules loaded lazily).
 * Mobile:  registers MobileHtmlView, a FileView built on the adapted Style HTML Viewer
 *          (vendored, MIT, taihoe/style-html-viewer v1.0.6): its resolver/PostCSS asset
 *          engine and preview lifecycle render HTML and JSON in a sandboxed iframe.
 *          No Node / Electron APIs are loaded on this path.
 */

import { FileView, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { MobileHtmlView, MOBILE_VIEW_TYPE } from "./src/mobile-view";
import { startDesktopServer } from "./src/desktop-server";
import type { ServerHandle } from "./src/desktop-server";
import { VaultWatcher } from "./src/vendor/style-html-viewer/src/watcher/VaultWatcher";

const REDIRECT_VIEW_TYPE = "open-in-webviewer-redirect";
const REDIRECT_EXTENSIONS = ["html", "htm", "json"];

/**
 * Lightweight redirect view used only on desktop: opens the file in the
 * webviewer tab then detaches itself.
 */
class RedirectView extends FileView {
	plugin: OpenInWebViewerPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: OpenInWebViewerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return REDIRECT_VIEW_TYPE;
	}

	getDisplayText() {
		return this.file?.basename ?? "Web Viewer";
	}

	async onLoadFile(file: TFile) {
		const successorLeaf = this.plugin.app.workspace.getLeaf("tab");
		await this.plugin.openInWebViewer(file, successorLeaf);
		this.leaf.detach();
	}
}

export default class OpenInWebViewerPlugin extends Plugin {
	private serverHandle: ServerHandle | null = null;
	private watcher: VaultWatcher | null = null;

	async onload() {
		if (Platform.isMobile) {
			// ---- Mobile path: register sandboxed FileView ----
			this.watcher = new VaultWatcher(this.app.vault);
			this.watcher.register();
			this.registerView(
				MOBILE_VIEW_TYPE,
				(leaf) => new MobileHtmlView(leaf, this.watcher!)
			);
			this.registerExtensions(REDIRECT_EXTENSIONS, MOBILE_VIEW_TYPE);

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (!(file instanceof TFile)) return;
					if (!REDIRECT_EXTENSIONS.includes(file.extension)) return;
					menu.addItem((item) => {
						item
							.setTitle("Open in Web Viewer")
							.setIcon("globe")
							.onClick(() => this.openMobile(file));
					});
				})
			);

			this.addCommand({
				id: "open-active-file-in-webviewer",
				name: "Open current file in Web Viewer",
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					const eligible =
						!!file && REDIRECT_EXTENSIONS.includes(file.extension);
					if (checking) return eligible;
					if (file) this.openMobile(file);
					return true;
				},
			});
		} else {
			// ---- Desktop path: HTTP server + core webviewer ----
			await this.startDesktop();

			this.registerView(
				REDIRECT_VIEW_TYPE,
				(leaf) => new RedirectView(leaf, this)
			);
			this.registerExtensions(REDIRECT_EXTENSIONS, REDIRECT_VIEW_TYPE);

			this.registerEvent(
				this.app.workspace.on("file-menu", (menu, file) => {
					if (!(file instanceof TFile)) return;
					if (!REDIRECT_EXTENSIONS.includes(file.extension)) return;
					menu.addItem((item) => {
						item
							.setTitle("Open in Web Viewer")
							.setIcon("globe")
							.onClick(() => this.openInWebViewer(file));
					});
				})
			);

			this.addCommand({
				id: "open-active-file-in-webviewer",
				name: "Open current file in Web Viewer",
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					const eligible =
						!!file && REDIRECT_EXTENSIONS.includes(file.extension);
					if (checking) return eligible;
					if (file) this.openInWebViewer(file);
					return true;
				},
			});
		}
	}

	onunload() {
		this.serverHandle?.close();
		this.serverHandle = null;
		this.watcher?.unregister();
		this.watcher = null;
	}

	/** Desktop: open file in Obsidian's core webviewer via HTTP URL. */
	async openInWebViewer(file: TFile, leaf?: WorkspaceLeaf) {
		const fileUrl = this.buildFileUrl(file);
		if (!fileUrl) {
			new Notice("Open in Web Viewer only works on desktop.");
			return;
		}
		const target = leaf ?? this.app.workspace.getLeaf("tab");
		await target.setViewState({
			type: "webviewer",
			state: { url: fileUrl, navigate: true },
			active: true,
		});
	}

	/** Mobile: open file in MobileHtmlView. */
	private async openMobile(file: TFile, leaf?: WorkspaceLeaf) {
		const target = leaf ?? this.app.workspace.getLeaf("tab");
		await target.setViewState({
			type: MOBILE_VIEW_TYPE,
			state: { file: file.path },
			active: true,
		});
	}

	private buildFileUrl(file: TFile): string | null {
		if (!this.serverHandle) return null;
		return `http://127.0.0.1:${this.serverHandle.port}/${file.path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
	}

	private async startDesktop(): Promise<void> {
		const vaultRoot = (
			this.app.vault.adapter as unknown as { basePath?: string }
		).basePath;
		if (!vaultRoot) return; // Not on desktop with FS access

		try {
			this.serverHandle = await startDesktopServer(vaultRoot);
		} catch (e) {
			console.error("[OpenInWebViewer] Failed to start server:", e);
		}
	}
}
