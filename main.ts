import { FileView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const REDIRECT_VIEW_TYPE = "open-in-webviewer-redirect";
const REDIRECT_EXTENSIONS = ["html", "htm", "json"];

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
};

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
	private server: http.Server | null = null;
	private serverPort: number | null = null;

	async onload() {
		await this.startServer();

		this.registerView(REDIRECT_VIEW_TYPE, (leaf) => new RedirectView(leaf, this));
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
				const eligible = !!file && REDIRECT_EXTENSIONS.includes(file.extension);
				if (checking) return eligible;
				if (file) this.openInWebViewer(file);
				return true;
			},
		});
	}

	onunload() {
		this.server?.close();
		this.server = null;
	}

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

	private buildFileUrl(file: TFile): string | null {
		if (!this.serverPort) return null;
		return `http://127.0.0.1:${this.serverPort}/${encodeURI(file.path.replace(/\\/g, "/"))}`;
	}

	private async startServer(): Promise<void> {
		const vaultRoot = (this.app.vault.adapter as any).getBasePath?.();
		if (!vaultRoot) return; // not on desktop

		this.server = http.createServer((req, res) => {
			const requestedPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
			const resolved = path.normalize(path.join(vaultRoot, requestedPath));

			if (!resolved.startsWith(path.normalize(vaultRoot))) {
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}

			fs.readFile(resolved, (err, data) => {
				if (err) {
					res.writeHead(404);
					res.end("Not found");
					return;
				}
				const ext = path.extname(resolved).toLowerCase();
				res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
				res.end(data);
			});
		});

		await new Promise<void>((resolve) => {
			this.server!.listen(0, "127.0.0.1", () => resolve());
		});

		const address = this.server.address();
		this.serverPort = typeof address === "object" && address ? address.port : null;
	}
}
