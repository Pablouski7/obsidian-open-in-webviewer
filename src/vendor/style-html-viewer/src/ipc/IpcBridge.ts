// Adapted from taihoe/style-html-viewer v1.0.6 (708c18c). Local changes are marked "LOCAL" and listed in ../../NOTICE.md.
import { App, Notice, TFile } from 'obsidian';
import { folderOf, isSpecialUrl, resolveVaultPath, splitUrl } from '../engine/paths';
import { isHiddenPath } from '../../../../security';
import { getStorageShimScript } from './StorageShim';

export interface IpcNavigatePayload { type: 'obsidian-navigate'; linkText: string; token?: string; newLeaf?: boolean }
export interface IpcOpenExternalPayload { type: 'obsidian-open-external'; url: string; token?: string }
export type IpcPayload = IpcNavigatePayload | IpcOpenExternalPayload;
export type PreviewCommand =
  | { action: 'find'; query: string }
  | { action: 'next'; direction: -1 | 1 }
  | { action: 'heading'; id: string }
  | { action: 'print' }
  | { action: 'fragment'; value: string };
export interface PreviewMessage { type: string; [key: string]: unknown }

/**
 * LOCAL: upstream imported its whole stylesheet here. The host chrome now lives in styles.css, so only the
 * search-highlight rules (formerly the last section of upstream styles.css) are embedded in the preview.
 */
export const PREVIEW_MATCH_STYLES = `
.html-viewer-match { background: #ffe16a; color: #171717; }
.html-viewer-current-match { outline: 2px solid #b65400; }
@media print { .html-viewer-match { background: transparent; color: inherit; } }
`;

/** Self-contained code serialized into the opaque preview; it never accesses parent DOM. */
function previewRuntime(token: string, styles: string, initialFragment: string): void {
  const send = (data: Record<string, unknown>) => window.parent.postMessage({ ...data, token }, '*');
  // The opaque iframe has no Obsidian DOM extensions. Clone a fixed, inert template
  // within this document instead of depending on the host's createEl helpers.
  const markTemplate = new DOMParser().parseFromString('<mark class="html-viewer-match"></mark>', 'text/html').querySelector('mark')!;
  let marks: HTMLElement[] = [];
  let current = -1;
  const reportMatches = () => send({ type: 'html-viewer-find', count: marks.length, current: current + 1 });
  const selectMatch = (direction: number) => {
    if (marks.length) {
      if (current >= 0) marks[current].classList.remove('html-viewer-current-match');
      current = (current + direction + marks.length) % marks.length;
      marks[current].classList.add('html-viewer-current-match');
      marks[current].scrollIntoView({ block: 'center' });
    }
    reportMatches();
  };
  const clearMatches = () => {
    for (const mark of marks) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ''));
      parent?.normalize();
    }
    marks = [];
    current = -1;
  };
  // LOCAL: a srcdoc document's base URL is the HOST page, so the browser resolves href="#id" to
  // "<host page>#id" and navigates the frame there (the document is replaced by the host page itself).
  // Fragment links are therefore completed inside the document. Setting location.hash uses the
  // document URL (about:srcdoc), which keeps :target and hashchange working.
  const goToFragment = (raw: string) => {
    let id = raw;
    try { id = decodeURIComponent(raw); } catch (error) { /* keep the raw value */ }
    const target = id ? (document.getElementById(id) || document.getElementsByName(id)[0] || null) : null;
    try { location.hash = raw; } catch (error) { /* not allowed here; scrolling below still works */ }
    if (target) target.scrollIntoView();
    else if (!id || id.toLowerCase() === 'top') window.scrollTo(0, 0);
  };
  // LOCAL: href="" / href=" " / SVG xlink:href resolve against the HOST page too, so EVERY anchor that carries any
  // href attribute is intercepted, not only "#id" ones. An empty href goes to the top, like a browser would.
  const XLINK = 'http://www.w3.org/1999/xlink';
  document.addEventListener('click', e => {
    const anchor = e.target instanceof Element ? e.target.closest('a, area') : null;
    if (!anchor) return;
    let raw = anchor.getAttribute('href');
    if (raw === null) raw = anchor.getAttributeNS(XLINK, 'href');
    if (raw === null) raw = anchor.getAttribute('xlink:href');
    if (raw === null) return;
    const href = raw.trim();
    e.preventDefault();
    if (!href || href.startsWith('#')) {
      goToFragment(href.slice(1));
      return;
    }
    if (!e.isTrusted) return;
    if (/^(https?:|mailto:)/i.test(href)) send({ type: 'obsidian-open-external', url: href });
    else send({ type: 'obsidian-navigate', linkText: href, newLeaf: e.ctrlKey || e.metaKey || e.shiftKey });
  }, true);
  document.addEventListener('submit', e => e.preventDefault(), true);
  document.addEventListener('securitypolicyviolation', e => {
    send({ type: 'html-viewer-diagnostic', path: e.blockedURI || 'Inline content', message: `Blocked by the viewer's content policy (${e.effectiveDirective})` });
  });
  window.addEventListener('error', e => {
    const target = e.target;
    if (target instanceof Element) send({ type: 'html-viewer-diagnostic', path: target.getAttribute('src') || target.tagName, message: 'Resource failed to load' });
    else if (e instanceof ErrorEvent) {
      // LOCAL: keep file/line, and say so when the browser hides the details of a cross-origin script.
      const hidden = !e.filename && /^Script error\.?$/.test(e.message);
      const where = e.lineno ? ` (line ${e.lineno}${e.colno ? ':' + e.colno : ''})` : '';
      send({
        type: 'html-viewer-diagnostic',
        path: e.filename && e.filename !== 'about:srcdoc' ? e.filename : 'Document script',
        message: (hidden ? 'The browser hid this script error because the script is cross-origin. ' : '') + e.message + where
      });
    }
  }, true);
  window.addEventListener('unhandledrejection', e => {
    send({ type: 'html-viewer-diagnostic', path: 'Document script', message: `Unhandled promise rejection: ${String(e.reason).slice(0, 300)}` });
  });
  window.addEventListener('afterprint', () => send({ type: 'html-viewer-ready' }));
  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    const input = e.data;
    if (e.source !== window.parent || !input || typeof input !== 'object' || Array.isArray(input)) return;
    const data = input as Record<string, unknown>;
    if (data.type !== 'html-viewer-command' || data.token !== token) return;
    if (data.action === 'find' && typeof data.query === 'string') {
      clearMatches();
      const query = data.query.slice(0, 300).toLowerCase();
      if (query && document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (parent && !parent.closest('script,style,noscript,textarea,input,select,[hidden]') && parent.getClientRects().length) nodes.push(node as Text);
        }
        for (const text of nodes) {
          const value = text.data;
          const lower = value.toLowerCase();
          let start = 0;
          let index = lower.indexOf(query);
          if (index < 0) continue;
          const fragment = new DocumentFragment();
          while (index >= 0 && marks.length < 1000) {
            fragment.append(document.createTextNode(value.slice(start, index)));
            const mark = document.importNode(markTemplate, true);
            mark.textContent = value.slice(index, index + query.length);
            fragment.append(mark);
            marks.push(mark);
            start = index + query.length;
            index = lower.indexOf(query, start);
          }
          fragment.append(document.createTextNode(value.slice(start)));
          text.replaceWith(fragment);
          if (marks.length >= 1000) break;
        }
      }
      selectMatch(1);
    } else if (data.action === 'next' && (data.direction === -1 || data.direction === 1)) selectMatch(data.direction);
    else if (data.action === 'heading' && typeof data.id === 'string') {
      const heading = Array.from(document.querySelectorAll('[data-html-viewer-heading]')).find(el => el.getAttribute('data-html-viewer-heading') === data.id);
      heading?.scrollIntoView({ block: 'start' });
    } else if (data.action === 'fragment' && typeof data.value === 'string') goToFragment(data.value.slice(0, 2000));
    else if (data.action === 'print') {
      clearMatches();
      reportMatches();
      window.print();
    }
  });
  const ready = () => {
    // The highlight rules cannot cross the iframe boundary, so adopt them here without injecting style tags.
    // Older WebViews still have native <mark> highlighting if adoption is unavailable.
    if ('adoptedStyleSheets' in document && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(styles);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
    if (initialFragment) goToFragment(initialFragment);
    send({ type: 'html-viewer-ready' });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
}

export function getClickInterceptorScript(token = '', initialFragment = ''): string {
  // Keep serialized arguments inside the script even if CSS contains an HTML closing tag.
  const args = [token, PREVIEW_MATCH_STYLES, initialFragment].map(value => JSON.stringify(value).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029')).join(',');
  // LOCAL: the storage fallback runs first, so it exists before any authored script.
  return `${getStorageShimScript(token)}\n(${previewRuntime.toString()})(${args});`;
}
export const IPC_SCRIPT_TEMPLATE = getClickInterceptorScript();

export class IpcBridge {
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private iframeEl: HTMLIFrameElement | null = null;
  private token = '';
  private hostWindow: Window;
  /** LOCAL: told about the target of a document link (path without suffix, fragment without '#') before it opens. */
  public onNavigate: ((path: string, fragment: string) => void) | null = null;
  /** LOCAL: the open failed, so the fragment recorded by onNavigate must be forgotten. */
  public onNavigateFailed: ((path: string) => void) | null = null;
  static readonly OPENABLE = new Set(['html', 'htm', 'json']);
  static MAX_NAVIGATIONS = 30;
  static MAX_NEW_LEAVES = 3;
  static MAX_EXTERNALS = 5;
  static EXTERNAL_INTERVAL_MS = 1500;
  private navigations = 0;
  private newLeaves = 0;
  private externals = 0;
  private lastExternal = 0;
  private opening = false;

  constructor(
    private app: App,
    private getSourcePath: () => string,
    private onMessage: (data: PreviewMessage) => void = () => {},
    hostWindow: Window = window
  ) { this.hostWindow = hostWindow; }

  public setIframe(iframeEl: HTMLIFrameElement | null, token = ''): void {
    this.iframeEl = iframeEl;
    this.token = token;
    // Limits are per frame: a new document gets fresh budgets.
    this.navigations = 0;
    this.newLeaves = 0;
    this.externals = 0;
    this.lastExternal = 0;
    const owner = iframeEl?.ownerDocument?.defaultView;
    if (owner && owner !== this.hostWindow) {
      const attached = Boolean(this.messageHandler);
      this.detach();
      this.hostWindow = owner;
      if (attached) this.attach();
    }
  }

  public send(command: PreviewCommand): void {
    this.iframeEl?.contentWindow?.postMessage({ type: 'html-viewer-command', token: this.token, ...command }, '*');
  }

  public attach(iframeEl?: HTMLIFrameElement | null): void {
    if (iframeEl !== undefined) this.setIframe(iframeEl);
    if (this.messageHandler) return;
    this.messageHandler = event => {
      try {
        const data: unknown = event.data;
        if (!data || typeof data !== 'object' || !('type' in data)) return;
        if (!this.iframeEl?.contentWindow || event.source !== this.iframeEl.contentWindow) return;
        const payload = data as PreviewMessage;
        if (this.token && payload.token !== this.token) return;
        if (payload.type === 'obsidian-navigate' && typeof payload.linkText === 'string') {
          this.navigate(payload.linkText, payload.newLeaf === true);
        } else if (payload.type === 'obsidian-open-external' && typeof payload.url === 'string') {
          this.offerExternal(payload.url);
        } else if (payload.type.startsWith('html-viewer-')) this.onMessage(payload);
      } catch (error) {
        // Safe error boundary for unexpected exceptions and invalid paths.
        this.onMessage({ type: 'html-viewer-diagnostic', path: 'Navigation', message: String(error) });
      }
    };
    this.hostWindow.addEventListener('message', this.messageHandler);
  }

  private diagnose(path: string, message: string): void {
    this.onMessage({ type: 'html-viewer-diagnostic', path: path.slice(0, 400), message });
  }

  /**
   * LOCAL: a document (or a script that read its token) can post arbitrary link text, so the host never asks
   * Obsidian to "open a link" (which creates a note for an unresolved one). It resolves the path itself and opens
   * only an EXISTING, visible html/htm/json file, within per-frame limits.
   */
  private navigate(linkText: string, newLeaf: boolean): void {
    if (++this.navigations > IpcBridge.MAX_NAVIGATIONS) {
      if (this.navigations === IpcBridge.MAX_NAVIGATIONS + 1) this.diagnose('Navigation', 'Too many link requests from this document; further ones are ignored');
      return;
    }
    const link = linkText.slice(0, 2000).trim();
    if (!link || isSpecialUrl(link)) return;
    const { path, suffix } = splitUrl(link);
    const sourcePath = this.getSourcePath();
    const resolved = resolveVaultPath(folderOf(sourcePath), path);
    const hash = suffix.indexOf('#');
    const fragment = hash >= 0 ? suffix.slice(hash + 1) : '';
    // A link back to the open document scrolls inside it; reloading the view would lose state and the fragment.
    if (resolved === sourcePath) {
      this.send({ action: 'fragment', value: fragment });
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(resolved);
    const extension = file instanceof TFile ? String(file.extension).toLowerCase() : '';
    const configDir = (this.app.vault.configDir || '.obsidian').replace(/\\/g, '/').toLowerCase();
    const lower = resolved.toLowerCase();
    if (!(file instanceof TFile) || !IpcBridge.OPENABLE.has(extension) || file.path !== resolved
      || isHiddenPath(file.path) || lower === configDir || lower.startsWith(configDir + '/')) {
      this.diagnose(link, 'Link target is not an existing HTML or JSON file in the vault');
      return;
    }
    if (this.opening) return;
    if (newLeaf && ++this.newLeaves > IpcBridge.MAX_NEW_LEAVES) {
      this.diagnose(link, 'Too many new tabs requested by this document');
      return;
    }
    this.opening = true;
    this.onNavigate?.(file.path, fragment);
    // Promise rejections need their own boundary; synchronous try/catch is insufficient.
    Promise.resolve().then(() => this.app.workspace.getLeaf(newLeaf ? 'tab' : false).openFile(file)).catch(error => {
      this.onNavigateFailed?.(file.path);
      this.diagnose(link, `Could not open link: ${String(error)}`);
    }).finally(() => { this.opening = false; });
  }

  /** LOCAL: never window.open from a message. The URL is shown so the reader can open it deliberately. */
  private offerExternal(raw: string): void {
    const url = raw.trim().slice(0, 300);
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return;
    const now = Date.now();
    if (++this.externals > IpcBridge.MAX_EXTERNALS || now - this.lastExternal < IpcBridge.EXTERNAL_INTERVAL_MS) return;
    this.lastExternal = now;
    new Notice(`This document links to ${url}. Links are not opened automatically; copy the address to open it yourself.`, 10000);
  }

  public detach(): void {
    if (this.messageHandler) this.hostWindow.removeEventListener('message', this.messageHandler);
    this.messageHandler = null;
  }
}
