// Adapted from taihoe/style-html-viewer v1.0.6 (708c18c). Local changes are listed in ../../NOTICE.md.
import { FileView, WorkspaceLeaf, TFile } from 'obsidian';
import { PreviewPanel } from '../preview/PreviewPanel';
import { VaultWatcher } from '../watcher/VaultWatcher';

/**
 * Obsidian file lifecycle adapter around PreviewPanel.
 *
 * LOCAL: upstream also registered header actions (source/reload/search/print) and a per-file script preference.
 * On mobile Obsidian already renders the native view header, and those actions live in the viewer's own compact
 * row and overflow menu, so none are added here. The view type id is supplied by the subclass in mobile-view.ts.
 */
export abstract class HtmlView extends FileView {
  private panel: PreviewPanel | null = null;

  constructor(leaf: WorkspaceLeaf, private watcher: VaultWatcher) {
    super(leaf);
  }

  public getDisplayText(): string { return this.file?.basename || 'HTML Viewer'; }
  public canAcceptExtension(extension: string): boolean { return /^(html|htm)$/i.test(extension); }

  private ensurePanel(): PreviewPanel {
    if (!this.panel) this.panel = new PreviewPanel(this.app, this.contentEl, this.watcher);
    return this.panel;
  }

  public async onLoadFile(file: TFile): Promise<void> {
    this.file = file;
    const render = this.ensurePanel().load(file);
    await super.onLoadFile(file);
    await render;
  }

  public async onUnloadFile(file: TFile): Promise<void> {
    this.panel?.unload();
    await super.onUnloadFile(file);
  }

  public async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    await this.ensurePanel().load(file);
  }

  public async onOpen(): Promise<void> {
    this.ensurePanel();
  }

  public refresh(): void { this.panel?.refresh(); }
  public toggleSource(): void { this.panel?.toggleSource(); }
  public focusSearch(): void { this.panel?.focusSearch(); }
  public print(): void { this.panel?.print(); }

  public disposePreview(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  public async onClose(): Promise<void> {
    this.disposePreview();
    await super.onClose();
  }
}
