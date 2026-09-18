import { FileView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";

const REDIRECT_VIEW_TYPE = "open-in-webviewer-redirect";
const REDIRECT_EXTENSIONS = ["html", "htm", "json"];

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
	async onload() {
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
		const adapterBasePath = (this.app.vault.adapter as any).getBasePath?.();
		if (!adapterBasePath) return null;

		const absolutePath = `${adapterBasePath}/${file.path}`;
		return "file://" + encodeURI(absolutePath.replace(/\\/g, "/"));
	}
}
