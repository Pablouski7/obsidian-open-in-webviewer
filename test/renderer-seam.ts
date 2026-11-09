// Contract-level Obsidian seam. The real plugin entry (main.ts), the registered
// view factory, Style's resolver / PostCSS / IPC bridge / PreviewPanel and the
// sandboxed iframe all run unmodified in Chromium against this API surface.
// It is NOT the native Obsidian runtime: layout, theme variables, header chrome
// and WKWebView behaviour on iOS are emulated or absent. See INTEGRATION-RESULTS.md.
//
// SDK reference (obsidian.d.ts): FileView.file/getState/setState/onLoadFile/
// onUnloadFile, TFile.path/basename/extension/stat, Vault.read/readBinary/
// getAbstractFileByPath/getFileByPath/on/offref, Workspace.openLinkText/getLeaf,
// WorkspaceLeaf.setViewState, HTMLElement.createEl/createDiv/empty/addClass.
const w = window as any;

interface ElInfo { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean | null>; title?: string; type?: string; placeholder?: string; value?: string; href?: string }

function applyInfo(el: HTMLElement, o: ElInfo | string = {}): void {
	const info: ElInfo = typeof o === 'string' ? { cls: o } : o;
	if (info.cls) for (const c of ([] as string[]).concat(info.cls)) el.classList.add(...c.split(/\s+/).filter(Boolean));
	if (info.text !== undefined) el.textContent = info.text;
	if (info.title) el.title = info.title;
	if (info.type) el.setAttribute('type', info.type);
	if (info.placeholder) el.setAttribute('placeholder', info.placeholder);
	if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
	if (info.href) el.setAttribute('href', info.href);
	for (const [k, v] of Object.entries(info.attr || {})) if (v !== null && v !== false) el.setAttribute(k, String(v));
}
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); },
	setText(this: HTMLElement, text: string) { this.textContent = text; },
	addClass(this: HTMLElement, ...c: string[]) { this.classList.add(...c); },
	removeClass(this: HTMLElement, ...c: string[]) { this.classList.remove(...c); },
	toggleClass(this: HTMLElement, c: string, on: boolean) { this.classList.toggle(c, on); },
	hasClass(this: HTMLElement, c: string) { return this.classList.contains(c); },
	createEl(this: HTMLElement, tag: string, o: ElInfo | string = {}) {
		const el = document.createElement(tag); applyInfo(el, o); this.append(el); return el;
	},
	createDiv(this: HTMLElement, o: ElInfo | string = {}) { return (this as any).createEl('div', o); },
	createSpan(this: HTMLElement, o: ElInfo | string = {}) { return (this as any).createEl('span', o); },
});

export class Notice { constructor(text: string) { (w.notices ??= []).push(text); } }
export const Platform = { isMobile: true };
export function setIcon(el: HTMLElement, id: string): void {
	el.dataset.icon = id;
	// Illustrative test-only SVGs; native Obsidian supplies its own Lucide icons.
	const shapes: Record<string, string> = {
		search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
		'refresh-cw': '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
		'more-horizontal': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
		ellipsis: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
		x: '<path d="m6 6 12 12M18 6 6 18"/>',
		'chevron-up': '<path d="m6 15 6-6 6 6"/>',
		'chevron-down': '<path d="m6 9 6 6 6-6"/>',
	};
	el.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (shapes[id] || '<circle cx="12" cy="12" r="8"/>') + '</svg>';
}

export class TFile {
	path: string; name: string; basename: string; extension: string; stat: { size: number };
	constructor(path: string, size = 0) {
		this.path = path; this.name = path.split('/').pop()!;
		const dot = this.name.lastIndexOf('.');
		this.basename = dot < 0 ? this.name : this.name.slice(0, dot);
		this.extension = dot < 0 ? '' : this.name.slice(dot + 1);
		this.stat = { size };
	}
}
export type TAbstractFile = TFile;

/** Text files are strings; binary fixtures are `{b64}` objects. */
export class Vault {
	files: Record<string, string | { b64: string }> = {};
	objects: Record<string, TFile> = {};
	sizes: Record<string, number> = {};
	handlers: Record<string, Array<{ cb: (...a: any[]) => void }>> = {};
	adapter: any = {};
	configDir = '.obsidian';
	reads: string[] = [];
	delays: Record<string, any> = {};
	private info(path: string): TFile | null {
		if (!(path in this.files)) return null;
		const v = this.files[path];
		// `sizes` lets a test declare the recorded file size (stat.size) without allocating that many bytes.
		const size = this.sizes[path] ?? (typeof v === 'string' ? v.length : v.b64.length * 0.75);
		const file = (this.objects[path] ??= new TFile(path, size));
		file.stat.size = size;
		return file;
	}
	getAbstractFileByPath(path: string) { return this.info(path); }
	getFileByPath(path: string) { return this.info(path); }
	async read(file: TFile): Promise<string> {
		this.reads.push(file.path);
		if (this.delays[file.path]) await new Promise(r => { this.delays[file.path] = r; });
		const v = this.files[file.path];
		if (typeof v !== 'string') throw new Error('Not text: ' + file.path);
		return v;
	}
	async readBinary(file: TFile): Promise<ArrayBuffer> {
		this.reads.push(file.path);
		const v = this.files[file.path];
		if (typeof v === 'string') return new TextEncoder().encode(v).buffer as ArrayBuffer;
		return Uint8Array.from(atob(v.b64), c => c.charCodeAt(0)).buffer;
	}
	on(name: string, cb: (...a: any[]) => void) { const ref = { cb }; (this.handlers[name] ??= []).push(ref); return { name, ref }; }
	offref(ref: { name: string; ref: any }) { this.handlers[ref.name] = (this.handlers[ref.name] || []).filter(h => h !== ref.ref); }
	emit(name: string, ...args: any[]) { for (const h of this.handlers[name] || []) h.cb(...args); }
	modify(path: string, content: string) { this.files[path] = content; this.emit('modify', this.info(path)); }
}

export class View {
	app: any; leaf: any; containerEl: HTMLElement; contentEl: HTMLElement; headerTitleEl: HTMLElement;
	constructor(leaf: any) {
		this.leaf = leaf; this.app = leaf.app;
		this.containerEl = document.createElement('div');
		this.containerEl.className = 'workspace-leaf-content';
		// Stand-in for the native view header that Obsidian itself renders.
		const header = this.containerEl.appendChild(document.createElement('div'));
		header.className = 'view-header';
		this.headerTitleEl = header.appendChild(document.createElement('span'));
		this.headerTitleEl.className = 'view-header-title';
		this.contentEl = this.containerEl.appendChild(document.createElement('div'));
		this.contentEl.className = 'view-content';
		document.body.append(this.containerEl);
	}
	getViewType(): string { return ''; }
	getDisplayText(): string { return ''; }
	getState(): Record<string, unknown> { return {}; }
	async setState(_state: any, _result: any): Promise<void> {}
	addAction(icon: string, title: string, _cb: () => void): HTMLElement {
		(w.nativeActions ??= []).push({ icon, title });
		return document.createElement('div');
	}
	updateTitle() { this.headerTitleEl.textContent = this.getDisplayText(); }
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}
export class FileView extends View {
	file: TFile | null = null;
	getState(): Record<string, unknown> { return { file: this.file?.path }; }
	getDisplayText(): string { return this.file?.basename ?? 'No file'; }
	async setState(state: any, result: any): Promise<void> {
		const file: TFile | null = state?.file ? this.app.vault.getFileByPath(state.file) : null;
		if (file === this.file) return;
		if (this.file) await this.onUnloadFile(this.file);
		this.file = file;
		if (file) await this.onLoadFile(file);
		void result;
	}
	async onLoadFile(_file: TFile): Promise<void> { this.updateTitle(); }
	async onUnloadFile(_file: TFile): Promise<void> {}
	async onRename(_file: TFile): Promise<void> {}
	async onClose(): Promise<void> { this.containerEl.remove(); }
}

export class WorkspaceLeaf {
	app: any; view: any = null;
	constructor(app: any) { this.app = app; }
	/** Documented WorkspaceLeaf.openFile(file): shows the file with the view registered for its extension. */
	async openFile(file: TFile): Promise<void> {
		const ws = this.app.workspace;
		ws.openedLinks.push({ linktext: file.path, sourcePath: this.view?.file?.path ?? '', newLeaf: ws.lastLeafHow === 'tab' });
		ws.leafOpens.push({ path: file.path, how: ws.lastLeafHow });
		await ws.openFile(file.path);
	}
	async setViewState(vs: { type: string; state?: any }): Promise<void> {
		const factory = this.app.plugin.views.get(vs.type);
		if (!factory) throw new Error('Unknown view type ' + vs.type);
		if (!this.view || this.view.getViewType() !== vs.type) {
			if (this.view) await this.view.onClose();
			this.view = factory(this);
			w.view = this.view;
			await this.view.onOpen();
		}
		await this.view.setState(vs.state || {}, {});
	}
}

export class Workspace {
	app: any; leaf: WorkspaceLeaf; handlers: Record<string, Array<(...a: any[]) => void>> = {};
	saves: Array<Record<string, unknown>> = [];
	navStack: string[] = [];
	openedLinks: Array<{ linktext: string; sourcePath: string; newLeaf: boolean }> = [];
	constructor(app: any) { this.app = app; this.leaf = new WorkspaceLeaf(app); }
	lastLeafHow: string | boolean | undefined = undefined;
	leafRequests: Array<string | boolean | undefined> = [];
	leafOpens: Array<{ path: string; how: string | boolean | undefined }> = [];
	/** Notes Obsidian would CREATE for an unresolved openLinkText; a correct host never reaches this. */
	createdNotes: string[] = [];
	getLeaf(how?: string | boolean) { this.lastLeafHow = how; this.leafRequests.push(how); return this.leaf; }
	getActiveFile() { return this.leaf.view?.file ?? this.activeFile ?? null; }
	activeFile: TFile | null = null;
	requestSaveLayout() { this.saves.push(this.leaf.view?.getState?.() ?? {}); }
	on(name: string, cb: (...a: any[]) => void) { (this.handlers[name] ??= []).push(cb); return { name, cb }; }
	trigger(name: string, ...args: any[]) { for (const cb of this.handlers[name] || []) cb(...args); }
	/** Open a vault file with the view registered for its extension (what Obsidian does on tap). */
	async openFile(path: string) {
		const ext = path.split('.').pop()!;
		const reg = this.app.plugin.extensions.find((e: any) => e.exts.includes(ext));
		if (!reg) throw new Error('No view registered for .' + ext);
		this.navStack.push(this.leaf.view?.file?.path || '');
		await this.leaf.setViewState({ type: reg.type, state: { file: path } });
	}
	async openLinkText(linktext: string, sourcePath: string, newLeaf = false) {
		this.openedLinks.push({ linktext, sourcePath, newLeaf });
		const path = decodeURIComponent(linktext.split('#')[0]);
		if (!this.app.vault.getFileByPath(path)) { this.createdNotes.push(path); return; }
		await this.openFile(path);
	}
	/** Native back gesture / navbar button stand-in. */
	async nativeBack() {
		const previous = this.navStack.pop();
		if (previous) await this.leaf.setViewState({ type: this.leaf.view.getViewType(), state: { file: previous } });
	}
}

export class App {
	vault = new Vault(); workspace: Workspace; plugin: any = null;
	constructor() { this.workspace = new Workspace(this); }
}

export class Plugin {
	app: App; manifest: any;
	views = new Map<string, (leaf: WorkspaceLeaf) => any>();
	extensions: Array<{ exts: string[]; type: string }> = [];
	commands: any[] = [];
	events: any[] = [];
	constructor(app: App, manifest?: any) { this.app = app; this.manifest = manifest; app.plugin = this; }
	registerView(type: string, factory: (leaf: WorkspaceLeaf) => any) {
		if (this.views.has(type)) throw new Error('View type already registered: ' + type);
		this.views.set(type, factory);
	}
	registerExtensions(exts: string[], type: string) {
		for (const ext of exts) if (this.extensions.some(e => e.exts.includes(ext))) throw new Error(`Extension '${ext}' already registered`);
		this.extensions.push({ exts, type });
	}
	registerEvent(ref: any) { this.events.push(ref); }
	addCommand(command: any) { this.commands.push(command); return command; }
	async loadData() { return null; }
	async saveData(_data: unknown) {}
}
export class Component {}
export class MarkdownRenderChild {}
export type EventRef = unknown;
export type Vault_ = Vault;
