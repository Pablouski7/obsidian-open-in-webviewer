// Adapted from taihoe/style-html-viewer v1.0.6 (708c18c). Local changes are listed in ../../NOTICE.md.
// What is kept from upstream: the render lifecycle (generation/current() guards, watcher registration, VaultResources,
// resolveHtmlAssets, IpcBridge token + source validation, sandboxed iframe, find/heading/print commands).
// What is local: a compact single-row reader chrome instead of a multi-row desktop control panel; document scripts
// always run (no checkbox, no per-file preference); JSON documents go through the same pipeline; diagnostics, headings
// and secondary actions open on demand as overlays so they never take viewport space permanently.
import { App, TFile, setIcon } from 'obsidian';
import { AssetDiagnostic, createBridgeToken, resolveHtmlAssets } from '../engine/HtmlAssetResolver';
import { folderOf } from '../engine/paths';
import { IpcBridge, PreviewMessage } from '../ipc/IpcBridge';
import { VaultWatcher } from '../watcher/VaultWatcher';
import { MAX_DOCUMENT_BYTES, VaultResources } from './VaultResources';
import { buildJsonPage } from '../../../../json-renderer';

/** Fragment of a link that is about to open another document (page.html#section), keyed by vault path. */
const pendingFragments = new Map<string, { fragment: string; at: number }>();
const MAX_PENDING_FRAGMENTS = 8;
const PENDING_FRAGMENT_TTL_MS = 15000;
export function rememberFragment(path: string, fragment: string): void {
  pendingFragments.delete(path);
  if (!fragment) return;
  pendingFragments.set(path, { fragment: fragment.slice(0, 500), at: Date.now() });
  while (pendingFragments.size > MAX_PENDING_FRAGMENTS) pendingFragments.delete(pendingFragments.keys().next().value as string);
}
function takeFragment(path: string): string {
  const entry = pendingFragments.get(path);
  pendingFragments.delete(path);
  return entry && Date.now() - entry.at <= PENDING_FRAGMENT_TTL_MS ? entry.fragment : '';
}
/** For tests: how many fragments are waiting for a document to open. */
export function pendingFragmentCount(): number { return pendingFragments.size; }

type SheetKind = 'diagnostics' | 'headings';

/** One preview implementation per view. */
export class PreviewPanel {
  private file: TFile | null = null;
  private registeredPath = '';
  private generation = 0;
  private disposed = false;
  private mode: 'preview' | 'source' = 'preview';
  private reloadTimer: number | undefined;
  private searchTimer: number | undefined;
  private readonly hostWindow: Window;
  private readonly bar: HTMLDivElement;
  private readonly primary: HTMLDivElement;
  private readonly searchRow: HTMLDivElement;
  private readonly searchButton: HTMLButtonElement;
  private readonly moreButton: HTMLButtonElement;
  private readonly search: HTMLInputElement;
  private readonly matches: HTMLElement;
  private readonly menu: HTMLDivElement;
  private readonly scrim: HTMLDivElement;
  private readonly sheet: HTMLDivElement;
  private readonly sheetTitle: HTMLElement;
  private readonly sheetBody: HTMLDivElement;
  private readonly sheetClose: HTMLButtonElement;
  private readonly viewport: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly menuItems: Record<string, HTMLButtonElement> = {};
  private readonly bridge: IpcBridge;
  private sheetKind: SheetKind | null = null;
  private returnFocus: HTMLElement | null = null;
  private diagnosticEntries: AssetDiagnostic[] = [];
  private dependencies: string[] = [];
  private headings: Array<{ id: string; text: string; level: number }> = [];
  private ready = false;
  private queryReady = false;
  private readonly keyHandler = (event: KeyboardEvent) => this.onKey(event);
  private readonly reloadCallback = () => {
    this.invalidate();
    this.hostWindow.clearTimeout(this.reloadTimer);
    this.reloadTimer = this.hostWindow.setTimeout(() => { void this.render(); }, 80);
  };

  constructor(
    private app: App,
    private container: HTMLElement,
    private watcher: VaultWatcher
  ) {
    this.hostWindow = container.ownerDocument.defaultView || window;
    container.empty();
    container.addClass('html-viewer-container');

    // ---- The one primary row: [title] [search] [reload] [more]; search swaps in place, it never adds a row.
    this.bar = container.createDiv({ cls: 'html-viewer-bar', attr: { role: 'toolbar', 'aria-label': 'HTML viewer' } });
    this.primary = this.bar.createDiv({ cls: 'html-viewer-bar-main' });
    this.title = this.primary.createSpan({ cls: 'html-viewer-title' });
    this.searchButton = this.iconButton(this.primary, 'search', 'Search', () => this.openSearch());
    this.iconButton(this.primary, 'refresh-cw', 'Reload', () => { void this.render(); });
    this.moreButton = this.iconButton(this.primary, 'more-horizontal', 'More actions', () => this.toggleMenu());
    this.moreButton.setAttribute('aria-haspopup', 'menu');
    this.moreButton.setAttribute('aria-expanded', 'false');

    this.searchRow = this.bar.createDiv({ cls: 'html-viewer-bar-search' });
    this.searchRow.hidden = true;
    this.search = this.searchRow.createEl('input', { attr: { type: 'search', placeholder: 'Find in document', 'aria-label': 'Find in document', maxlength: '300', enterkeyhint: 'search' } });
    this.search.addEventListener('input', () => {
      this.hostWindow.clearTimeout(this.searchTimer);
      this.searchTimer = this.hostWindow.setTimeout(() => this.find(), 120);
    });
    this.search.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.bridge.send({ action: 'next', direction: event.shiftKey ? -1 : 1 }); }
    });
    this.matches = this.searchRow.createSpan({ cls: 'html-viewer-matches', attr: { role: 'status', 'aria-live': 'polite' } });
    this.iconButton(this.searchRow, 'chevron-up', 'Previous match', () => this.bridge.send({ action: 'next', direction: -1 }));
    this.iconButton(this.searchRow, 'chevron-down', 'Next match', () => this.bridge.send({ action: 'next', direction: 1 }));
    this.iconButton(this.searchRow, 'x', 'Close search', () => this.closeSearch());

    // ---- Document viewport (fills everything below the row).
    this.viewport = container.createDiv({ cls: 'html-viewer-preview-container' });

    // ---- Overlays: all hidden until asked for; they float over the document instead of resizing it.
    this.scrim = container.createDiv({ cls: 'html-viewer-scrim' });
    this.scrim.hidden = true;
    this.scrim.addEventListener('click', () => { this.closeMenu(false); this.closeSheet(); });
    this.menu = container.createDiv({ cls: 'html-viewer-menu', attr: { role: 'menu', 'aria-label': 'Viewer actions' } });
    this.menu.hidden = true;
    this.menuItem('source', 'View source', () => this.toggleSource());
    this.menuItem('headings', 'Jump to heading', () => this.openSheet('headings'));
    this.menuItem('print', 'Print / save PDF', () => this.print());
    this.menuItem('diagnostics', 'Diagnostics', () => this.openSheet('diagnostics'));
    this.menu.addEventListener('keydown', event => this.onMenuKey(event));

    this.sheet = container.createDiv({ cls: 'html-viewer-sheet', attr: { role: 'dialog', 'aria-modal': 'false' } });
    this.sheet.hidden = true;
    const sheetHeader = this.sheet.createDiv({ cls: 'html-viewer-sheet-header' });
    this.sheetTitle = sheetHeader.createEl('h2', { cls: 'html-viewer-sheet-title' });
    this.sheetClose = this.iconButton(sheetHeader, 'x', 'Close', () => this.closeSheet());
    this.sheetBody = this.sheet.createDiv({ cls: 'html-viewer-sheet-body' });

    container.addEventListener('keydown', this.keyHandler);
    this.bridge = new IpcBridge(app, () => this.file?.path || '', message => this.onMessage(message), this.hostWindow);
    this.bridge.onNavigate = (path, fragment) => rememberFragment(path, fragment);
    this.bridge.onNavigateFailed = path => { pendingFragments.delete(path); };
    this.bridge.attach();
    this.updateChrome();
  }

  // ------------------------------------------------------------------ chrome

  private iconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'html-viewer-button', attr: { type: 'button', 'aria-label': label, title: label } });
    setIcon(button, icon);
    button.addEventListener('click', action);
    return button;
  }

  private menuItem(action: string, text: string, run: () => void): void {
    const item = this.menu.createEl('button', { cls: 'html-viewer-menu-item', text, attr: { type: 'button', role: 'menuitem', 'data-action': action } });
    item.addEventListener('click', () => { this.closeMenu(false); run(); });
    this.menuItems[action] = item;
  }

  private updateChrome(): void {
    const preview = this.mode === 'preview';
    this.title.textContent = this.file?.name || '';
    this.searchButton.disabled = !preview;
    this.menuItems.source.textContent = preview ? 'View source' : 'View preview';
    this.menuItems.headings.disabled = !preview || !this.headings.length;
    this.menuItems.print.disabled = !preview || !this.ready;
    this.menuItems.diagnostics.textContent = `Diagnostics (${this.diagnosticEntries.length})`;
    if (this.diagnosticEntries.length) this.moreButton.setAttribute('data-issues', String(this.diagnosticEntries.length));
    else this.moreButton.removeAttribute('data-issues');
  }

  private toggleMenu(): void { if (this.menu.hidden) this.openMenu(); else this.closeMenu(true); }

  private openMenu(): void {
    this.closeSheet(false);
    this.menu.hidden = false;
    this.moreButton.setAttribute('aria-expanded', 'true');
    this.syncScrim();
    this.menu.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }

  private closeMenu(restoreFocus: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.moreButton.setAttribute('aria-expanded', 'false');
    this.syncScrim();
    if (restoreFocus) this.moreButton.focus();
  }

  private openSheet(kind: SheetKind): void {
    this.closeMenu(false);
    this.returnFocus = this.moreButton;
    this.sheetKind = kind;
    this.fillSheet();
    this.sheet.hidden = false;
    this.sheet.setAttribute('aria-label', kind === 'diagnostics' ? 'Diagnostics' : 'Headings');
    this.syncScrim();
    this.sheetClose.focus();
  }

  private closeSheet(restoreFocus = true): void {
    if (this.sheet.hidden) return;
    this.sheet.hidden = true;
    this.sheetKind = null;
    this.syncScrim();
    if (restoreFocus) this.returnFocus?.focus();
  }

  private syncScrim(): void { this.scrim.hidden = this.menu.hidden && this.sheet.hidden; }

  private fillSheet(): void {
    this.sheetBody.empty();
    if (this.sheetKind === 'headings') {
      this.sheetTitle.textContent = 'Jump to heading';
      for (const heading of this.headings) {
        const item = this.sheetBody.createEl('button', { cls: 'html-viewer-heading-item', text: heading.text || '(untitled)', attr: { type: 'button', 'data-heading': heading.id } });
        item.style.paddingLeft = `${12 + (heading.level - 1) * 14}px`;
        item.addEventListener('click', () => { this.bridge.send({ action: 'heading', id: heading.id }); this.closeSheet(); });
      }
      return;
    }
    this.sheetTitle.textContent = 'Diagnostics';
    this.sheetBody.createEl('h3', { text: `Issues (${this.diagnosticEntries.length})` });
    if (!this.diagnosticEntries.length) this.sheetBody.createEl('p', { text: 'No asset or script issues reported.' });
    const issues = this.sheetBody.createEl('ul', { cls: 'html-viewer-issues' });
    for (const entry of this.diagnosticEntries) issues.createEl('li', { cls: `is-${entry.kind}`, text: `${entry.path}: ${entry.message}` });
    if (this.dependencies.length) {
      this.sheetBody.createEl('h3', { text: `Vault files used (${this.dependencies.length})` });
      const assets = this.sheetBody.createEl('ul');
      for (const path of this.dependencies) assets.createEl('li', { text: path });
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (!this.sheet.hidden) { event.preventDefault(); this.closeSheet(); }
    else if (!this.menu.hidden) { event.preventDefault(); this.closeMenu(true); }
    else if (!this.searchRow.hidden) { event.preventDefault(); this.closeSearch(); }
  }

  private onMenuKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(this.menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(this.menu.ownerDocument.activeElement as HTMLButtonElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }

  // ------------------------------------------------------------------ search

  private openSearch(): void {
    if (this.mode !== 'preview') return;
    this.closeMenu(false);
    this.closeSheet(false);
    this.primary.hidden = true;
    this.searchRow.hidden = false;
    this.search.focus();
    this.search.select();
  }

  private closeSearch(): void {
    if (this.searchRow.hidden) return;
    this.hostWindow.clearTimeout(this.searchTimer);
    this.search.value = '';
    this.find();
    this.matches.textContent = '';
    this.searchRow.hidden = true;
    this.primary.hidden = false;
    this.searchButton.focus();
  }

  private find(): void {
    if (this.queryReady) this.bridge.send({ action: 'find', query: this.search.value });
  }

  // ------------------------------------------------------------------ lifecycle

  public async load(file: TFile): Promise<void> {
    this.invalidate();
    this.watcher.unregisterCallback(this.reloadCallback);
    this.file = file;
    this.registeredPath = file.path;
    this.watcher.registerView(file.path, this.reloadCallback);
    await this.render();
  }

  public unload(): void {
    this.invalidate();
    this.hostWindow.clearTimeout(this.reloadTimer);
    this.hostWindow.clearTimeout(this.searchTimer);
    this.watcher.unregisterCallback(this.reloadCallback);
    this.file = null;
    this.registeredPath = '';
    this.bridge.setIframe(null);
    this.viewport.empty();
  }

  public dispose(): void {
    this.disposed = true;
    this.unload();
    this.bridge.detach();
    this.container.removeEventListener('keydown', this.keyHandler);
  }

  public toggleSource(): void { this.mode = this.mode === 'preview' ? 'source' : 'preview'; void this.render(); }
  public focusSearch(): void { this.openSearch(); }
  public print(): void { if (this.ready && this.mode === 'preview') this.bridge.send({ action: 'print' }); }
  public refresh(): void { void this.render(); }

  private invalidate(): void {
    this.generation++;
    this.ready = false;
    this.queryReady = false;
    this.menuItems.print.disabled = true;
    // An obsolete document cannot keep issuing navigation while a new file is loading.
    this.bridge.setIframe(null);
  }

  private onMessage(message: PreviewMessage): void {
    if (message.type === 'html-viewer-ready') { this.queryReady = true; this.find(); }
    if (message.type === 'html-viewer-find' && typeof message.count === 'number' && typeof message.current === 'number') {
      this.matches.textContent = message.count ? `${message.current} / ${message.count}${message.count >= 1000 ? '+' : ''}` : (this.search.value ? 'No matches' : '');
    }
    if (message.type === 'html-viewer-diagnostic' && typeof message.path === 'string' && typeof message.message === 'string') {
      this.report({ kind: message.kind === 'notice' ? 'notice' : 'blocked', path: message.path.slice(0, 400), message: message.message.slice(0, 500) });
    }
  }

  private report(diagnostic: AssetDiagnostic): void {
    if (this.disposed || this.diagnosticEntries.length >= 200) return;
    if (!this.diagnosticEntries.some(entry => entry.path === diagnostic.path && entry.message === diagnostic.message)) this.diagnosticEntries.push(diagnostic);
    this.updateChrome();
    if (this.sheetKind === 'diagnostics') this.fillSheet();
  }

  private async render(): Promise<void> {
    if (this.disposed || !this.file) return;
    this.invalidate();
    this.hostWindow.clearTimeout(this.reloadTimer);
    const id = this.generation;
    const file = this.file;
    const path = file.path;
    const mode = this.mode;
    const current = () => !this.disposed && id === this.generation && this.file === file && file.path === path && this.mode === mode;
    if (this.registeredPath !== path) {
      this.watcher.unregisterCallback(this.reloadCallback);
      this.watcher.registerView(path, this.reloadCallback);
      this.registeredPath = path;
    }
    this.closeMenu(false);
    this.closeSheet(false);
    if (mode !== 'preview') this.closeSearch();
    this.matches.textContent = '';
    this.diagnosticEntries = [];
    this.dependencies = [];
    this.headings = [];
    this.updateChrome();
    this.viewport.empty();
    this.viewport.createEl('p', { cls: 'html-viewer-loading', text: 'Loading…', attr: { role: 'status' } });
    try {
      // Check the recorded size BEFORE the vault reads the whole file into memory, and the text size afterwards.
      const recorded = file.stat?.size;
      if (typeof recorded !== 'number' || !Number.isFinite(recorded) || recorded < 0) throw new Error('File size is unavailable; not loading it');
      if (recorded > MAX_DOCUMENT_BYTES) throw new Error('File exceeds the 10 MB preview limit');
      const rawHtml = await this.app.vault.read(file);
      if (!current()) return;
      if (rawHtml.length > MAX_DOCUMENT_BYTES) throw new Error('File exceeds the 10 MB preview limit');
      if (mode === 'source') {
        this.watcher.updateDependencies(path, [], this.reloadCallback);
        this.viewport.empty();
        this.viewport.createEl('pre', { cls: 'html-viewer-source-container', text: rawHtml });
        return;
      }
      if (!rawHtml.replace(/\0/g, '').trim()) throw new Error('File is empty');
      const resources = new VaultResources(this.app.vault);
      const token = createBridgeToken();
      const fragment = takeFragment(path);
      const result = await resolveHtmlAssets({
        rawHtml: path.toLowerCase().endsWith('.json') ? buildJsonPage(rawHtml) : rawHtml,
        currentFileFolderPath: folderOf(path), bridgeToken: token,
        allowScripts: true, initialFragment: fragment,
        getResourcePathFn: asset => resources.dataUrl(asset),
        readVaultFileFn: asset => resources.readText(asset)
      });
      if (!current()) return;
      this.dependencies = result.assetPaths;
      this.diagnosticEntries = result.diagnostics.slice(0, 200);
      this.headings = result.headings;
      this.watcher.updateDependencies(path, result.assetPaths, this.reloadCallback);
      this.updateChrome();
      this.viewport.empty();
      const frame = this.viewport.createEl('iframe', {
        cls: 'html-viewer-iframe', attr: { sandbox: 'allow-scripts allow-modals', title: `HTML preview: ${file.basename}`, referrerpolicy: 'no-referrer' }
      });
      this.bridge.setIframe(frame, token);
      frame.addEventListener('load', () => {
        if (!current()) return;
        this.ready = true;
        this.updateChrome();
      }, { once: true });
      frame.srcdoc = result.transformedHtml;
    } catch (error) {
      pendingFragments.delete(path);
      if (!current()) return;
      this.bridge.setIframe(null);
      this.viewport.empty();
      const errorContainer = this.viewport.createDiv({ cls: 'html-viewer-error-container' });
      const card = errorContainer.createDiv({ cls: 'html-viewer-error-card' });
      const header = card.createDiv({ cls: 'html-viewer-error-header' });
      header.createEl('strong', { cls: 'html-viewer-error-title', text: 'Error Loading File' });
      card.createEl('p', { cls: 'html-viewer-error-message', text: error instanceof Error ? error.message : String(error) });
      this.report({ kind: 'error', path, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
