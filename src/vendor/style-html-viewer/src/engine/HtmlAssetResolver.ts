// Adapted from taihoe/style-html-viewer v1.0.6 (708c18c). Local changes are marked "LOCAL" and listed in ../../NOTICE.md.
import { getClickInterceptorScript } from '../ipc/IpcBridge';
import { resolveCss, rewriteCssValue, CssContext } from './css';
import { isSpecialUrl, parseSrcset, resolveVaultPath, splitUrl } from './paths';

export interface AssetDiagnostic {
  /** LOCAL: 'notice' = informational (for example an in-memory storage fallback is active). */
  kind: 'missing' | 'blocked' | 'error' | 'notice';
  path: string;
  message: string;
}

export interface ResolveHtmlAssetsOptions {
  /** Raw HTML document string */
  rawHtml: string;
  /** Relative directory path of the active HTML file within the vault (e.g., "lessons" or "") */
  currentFileFolderPath: string;
  /** Injected function resolving normalized vault path to a resource URI (data URLs in the plugin). */
  getResourcePathFn: (vaultPath: string) => string | Promise<string>;
  /** Injected function reading a file from the vault asynchronously */
  readVaultFileFn?: (vaultPath: string) => Promise<string>;
  /**
   * LOCAL: upstream defaulted to false (opt-in). The mobile reader always runs document scripts, inside the
   * sandbox + CSP below, so the default is true. Pass false only to preview a document inertly.
   */
  allowScripts?: boolean;
  bridgeToken?: string;
  /** LOCAL: fragment (without '#') to scroll to once the document is ready, for links like page.html#section. */
  initialFragment?: string;
  /** LOCAL: hard cap on characters EMITTED into the preview document (default MAX_OUTPUT_CHARS). Injectable for tests. */
  maxOutputChars?: number;
}

export interface ResolveHtmlAssetsResult {
  /** The transformed HTML document string with updated URLs, CSP, and IPC script */
  transformedHtml: string;
  /** List of relative vault file paths discovered and transformed (used for live reload dependency tracking) */
  assetPaths: string[];
  diagnostics: AssetDiagnostic[];
  headings: Array<{ id: string; text: string; level: number }>;
}

/**
 * LOCAL: input caches keep each file once, but a document can reference one cached asset many times and every
 * occurrence is copied into the output. Every emitted copy (data URL, stylesheet or script text) is charged.
 */
export const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

/** LOCAL: say why a remote URL is refused instead of a generic message. */
function describeBlocked(url: string, what = 'resource'): string {
  if (/^(?:https?:)?\/\//i.test(url.trim())) {
    return `Remote ${what} blocked: the reader loads files from your vault only, so the page uses its fallback ${what === 'stylesheet' ? 'styles and fonts' : 'content'}`;
  }
  return `This kind of URL is not allowed for a ${what}`;
}

export function createBridgeToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Pure function that parses HTML, transforms relative asset paths to vault resource URIs,
 * injects a Content Security Policy meta tag, and embeds the IPC click interception script.
 * All I/O is injected; document content cannot broaden the plugin's security policy.
 */
export async function resolveHtmlAssets(options: ResolveHtmlAssetsOptions): Promise<ResolveHtmlAssetsResult> {
  const { rawHtml, currentFileFolderPath, getResourcePathFn, readVaultFileFn, allowScripts = true } = options;
  const token = options.bridgeToken || createBridgeToken();
  const assetPaths = new Set<string>();
  const diagnostics: AssetDiagnostic[] = [];
  const report = (kind: AssetDiagnostic['kind'], path: string, message: string) => {
    if (!diagnostics.some(d => d.kind === kind && d.path === path && d.message === message)) diagnostics.push({ kind, path, message });
  };
  const outputBudget = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  let emitted = rawHtml.length;
  /** Reserve room for text about to be copied into the output; throws BEFORE it is inserted or serialized. */
  const charge = (chars: number, what: string) => {
    if (emitted + chars > outputBudget) throw new Error(`Output budget exceeded: ${what} would take the preview past ${(outputBudget / 1048576).toFixed(1)} MiB; skipped`);
    emitted += chars;
  };
  charge(2048, 'document framing (policy, canvas style, serialization overhead)');
  // The viewer's own script is always emitted: reserve it first so assets, not the reader, are what gets cut.
  const bridgeScript = getClickInterceptorScript(token, options.initialFragment || '');
  charge(bridgeScript.length, 'viewer script');
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');
  // These nodes belong to serialized, inert preview HTML, not Obsidian's UI.
  // A fixed scaffold keeps this resolver independent of host-only DOM helpers.
  const scaffold = parser.parseFromString('<head><style></style><meta><script></script></head>', 'text/html');
  const styleTemplate = scaffold.querySelector('style')!;
  const resourceCache = new Map<string, Promise<string>>();
  const stylesheetCache = new Map<string, Promise<string>>();
  let stylesheetReads = 0;
  const resolveAsset = async (url: string, folder: string): Promise<string> => {
    const value = url.trim();
    if (!value || value.startsWith('#')) return value;
    if (/^(data:|blob:)/i.test(value)) return value;
    if (isSpecialUrl(value)) {
      report('blocked', value, describeBlocked(value));
      return '';
    }
    try {
      const { path, suffix } = splitUrl(value);
      const vaultPath = resolveVaultPath(folder, path);
      assetPaths.add(vaultPath);
      if (!resourceCache.has(vaultPath)) resourceCache.set(vaultPath, Promise.resolve().then(() => getResourcePathFn(vaultPath)));
      const uri = await resourceCache.get(vaultPath)!;
      if (!uri) throw new Error('Resource unavailable');
      charge(uri.length, vaultPath);
      // Query strings cache-bust files, not embedded data. SVG fragments still select symbols.
      return uri + (/^data:/i.test(uri) ? (suffix.includes('#') ? suffix.slice(suffix.indexOf('#')) : '') : suffix);
    } catch (error) {
      report('missing', value, error instanceof Error ? error.message : String(error));
      return '';
    }
  };
  const cssContext: CssContext = {
    resolveAsset,
    readStylesheet: async path => {
      assetPaths.add(path);
      if (++stylesheetReads > 256) throw new Error('Stylesheet import limit exceeded');
      if (!readVaultFileFn) throw new Error('Stylesheet reader unavailable');
      if (!stylesheetCache.has(path)) stylesheetCache.set(path, readVaultFileFn(path));
      const text = await stylesheetCache.get(path)!;
      charge(text.length, path);
      return text;
    },
    report: (path, message) => report('error', path, message)
  };
  const processAttribute = async (node: Element, attribute: string) => {
    const raw = node.getAttribute(attribute);
    if (raw) {
      const uri = await resolveAsset(raw, currentFileFolderPath);
      if (uri) node.setAttribute(attribute, uri);
      else node.removeAttribute(attribute);
    }
  };

  // Find all CSP meta tags (case-insensitive value match, trimmed).
  // Refresh/base elements cannot redirect a preview or change its security origin.
  doc.querySelectorAll('meta[http-equiv], base').forEach(node => {
    const directive = node.getAttribute('http-equiv')?.trim().toLowerCase();
    if (node.tagName.toLowerCase() === 'base' || directive === 'content-security-policy' || directive === 'refresh') node.remove();
  });
  doc.querySelectorAll('iframe, frame, frameset, object, embed').forEach(node => {
    report('blocked', node.getAttribute('src') || node.getAttribute('data') || node.tagName.toLowerCase(), 'Nested active content is blocked');
    node.remove();
  });
  doc.querySelectorAll('*').forEach(node => {
    for (const attribute of Array.from(node.attributes)) {
      if ((!allowScripts && /^on/i.test(attribute.name)) || attribute.name === 'nonce' || attribute.name === 'ping') node.removeAttribute(attribute.name);
      if (/^\s*javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
    }
  });

  // Process asset elements. Inline styles are processed before linked styles so resolved CSS
  // is never processed twice in the wrong directory.
  for (const node of Array.from(doc.querySelectorAll('style'))) {
    try {
      const css = await resolveCss(node.textContent || '', `${currentFileFolderPath ? currentFileFolderPath + '/' : ''}__inline__.css`, cssContext);
      node.textContent = css.toString().replace(/<\/style/gi, '<\\/style');
    } catch (error) {
      report('error', 'Inline stylesheet', String(error));
      node.remove();
    }
  }
  for (const node of Array.from(doc.querySelectorAll('link[href]'))) {
    const rel = (node.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const href = node.getAttribute('href') || '';
    if (!rel.includes('stylesheet')) {
      // Preloads, preconnect and alternate navigation are unnecessary for an embedded document.
      node.remove();
      continue;
    }
    try {
      if (isSpecialUrl(href)) throw new Error(describeBlocked(href, 'stylesheet'));
      const path = resolveVaultPath(currentFileFolderPath, splitUrl(href).path);
      const text = await cssContext.readStylesheet(path);
      const css = await resolveCss(text, path, cssContext);
      const style = doc.importNode(styleTemplate, true);
      style.textContent = css.toString().replace(/<\/style/gi, '<\\/style');
      for (const attribute of ['media', 'title']) {
        if (node.hasAttribute(attribute)) style.setAttribute(attribute, node.getAttribute(attribute)!);
      }
      // Disabled and alternate sheets must not become active during inlining.
      if (node.hasAttribute('disabled') || rel.includes('alternate')) style.setAttribute('media', 'not all');
      node.replaceWith(style);
    } catch (error) {
      report(isSpecialUrl(href) ? 'blocked' : 'missing', href, error instanceof Error ? error.message : String(error));
      node.remove();
    }
  }
  for (const node of Array.from(doc.querySelectorAll('[style]'))) {
    node.setAttribute('style', await rewriteCssValue(node.getAttribute('style') || '', currentFileFolderPath, cssContext));
  }
  // LOCAL: upstream turned `<script src>` into a data: URL. Browsers hide the details of errors raised by
  // cross-origin scripts ("Script error."), and a data: script is cross-origin to its own document. Local scripts
  // are inlined instead, so failures keep their message, file and line. `defer` is reproduced by moving the
  // script to the end of <body>, which is when deferred classic scripts run.
  const deferred: Element[] = [];
  const inlineScript = async (script: Element) => {
    const raw = (script.getAttribute('src') || '').trim();
    if (/^(data|blob):/i.test(raw)) return;
    if (isSpecialUrl(raw)) {
      report('blocked', raw, describeBlocked(raw, 'script'));
      script.remove();
      return;
    }
    try {
      const vaultPath = resolveVaultPath(currentFileFolderPath, splitUrl(raw).path);
      assetPaths.add(vaultPath);
      if (!readVaultFileFn) throw new Error('Script reader unavailable');
      const text = await readVaultFileFn(vaultPath);
      charge(text.length, vaultPath);
      for (const attribute of ['src', 'integrity', 'crossorigin']) script.removeAttribute(attribute);
      script.textContent = text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
      const isModule = (script.getAttribute('type') || '').toLowerCase() === 'module';
      if (isModule && /^\s*(?:import\s*(?:[\w{*"']|\()|export\s+\w*\s*[{*]?[^;]*\sfrom\s)/m.test(text)) {
        report('error', raw, 'Module scripts cannot import other files inside the sandbox; bundle it into one classic script');
      }
      if (!isModule && script.hasAttribute('defer')) deferred.push(script);
      script.removeAttribute('defer');
    } catch (error) {
      report('missing', raw, error instanceof Error ? error.message : String(error));
      script.remove();
    }
  };
  for (const script of Array.from(doc.querySelectorAll('script'))) {
    if (!allowScripts) {
      if (script.getAttribute('src')) report('blocked', script.getAttribute('src')!, 'Document scripts are disabled');
      script.remove();
    } else if (script.hasAttribute('src')) {
      await inlineScript(script);
    }
  }
  for (const script of deferred) doc.body.append(script);
  for (const node of Array.from(doc.querySelectorAll('img, video, audio, source, track, input[type="image"], image'))) {
    for (const attribute of ['src', 'poster', 'href', 'xlink:href']) await processAttribute(node, attribute);
    if (node.hasAttribute('srcset')) {
      const candidates = await Promise.all(parseSrcset(node.getAttribute('srcset')!).map(async candidate => {
        const uri = await resolveAsset(candidate.url, currentFileFolderPath);
        return uri ? uri + (candidate.descriptor ? ` ${candidate.descriptor}` : '') : '';
      }));
      node.setAttribute('srcset', candidates.filter(Boolean).join(', '));
    }
  }
  const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((heading, index) => {
    // A dedicated identifier avoids collisions with document-provided ids.
    const id = `html-viewer-heading-${token}-${index}`;
    heading.setAttribute('data-html-viewer-heading', id);
    return { id, text: (heading.textContent || '').trim().slice(0, 300), level: Number(heading.tagName.slice(1)) };
  });

  // Ensure <head> exists (the HTML parser supplies one even for fragments).
  const head = doc.head;
  // Gather allowed sources for CSP. Vault assets are embedded by the host, never fetched remotely.
  const policy = [
    "default-src 'none'", "base-uri 'none'", "connect-src 'none'", "form-action 'none'",
    "object-src 'none'", "frame-src 'none'", "worker-src 'none'",
    `script-src ${allowScripts ? "'unsafe-inline' data: blob:" : `'nonce-${token}'`}`,
    `script-src-attr ${allowScripts ? "'unsafe-inline'" : "'none'"}`,
    "style-src 'unsafe-inline'", "img-src data: blob:", "media-src data: blob:", "font-src data: blob:"
  ].join('; ') + ';';
  const csp = doc.importNode(scaffold.querySelector('meta')!, true);
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', policy);
  head.prepend(csp);

  // Inject IPC Script ahead of document scripts. Only this script runs in script-disabled mode.
  const bridge = doc.importNode(scaffold.querySelector('script')!, true);
  bridge.setAttribute('nonce', token);
  bridge.textContent = bridgeScript;
  csp.after(bridge);
  // LOCAL: declared before any authored CSS so authored themes win. Light is the browser default; stating it keeps
  // the document's colour scheme equal to the iframe element's (styles.css gives that element the white canvas).
  const canvas = doc.importNode(styleTemplate, true);
  canvas.textContent = ':root{color-scheme:light}';
  bridge.after(canvas);
  return {
    transformedHtml: (doc.doctype ? '<!DOCTYPE html>\n' : '') + doc.documentElement.outerHTML,
    assetPaths: [...assetPaths],
    diagnostics,
    headings
  };
}
