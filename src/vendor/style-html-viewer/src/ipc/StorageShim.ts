/**
 * LOCAL ADDITION (not part of taihoe/style-html-viewer).
 *
 * The preview iframe is sandboxed WITHOUT allow-same-origin, so its origin is opaque and the browser
 * throws SecurityError the first time a script touches window.localStorage / sessionStorage. Real
 * documents read storage at the top of their main script (theme, last tab, progress); one throw
 * aborts the whole script and nothing after it, such as tab wiring, ever runs.
 *
 * This installs a Storage-compatible, IN-MEMORY replacement for whichever store is unusable. It runs
 * as the first script in the document, before any authored script. Values live only as long as the
 * document: they are NOT saved across reload or reopen, and the diagnostics sheet says so the first
 * time a document uses a store.
 *
 * The function is serialized with Function#toString, so it must stay free of references to anything
 * outside its own body (no imports, no helpers, no top-level constants).
 */
export function installStorageFallback(token: string): void {
  const win = window as unknown as Record<string, unknown> & { parent: Window };
  const tell = (name: string, message: string): void => {
    try { win.parent.postMessage({ type: 'html-viewer-diagnostic', kind: 'notice', path: name, message, token }, '*'); }
    catch (error) { /* the host is gone; nothing to tell */ }
  };
  ['localStorage', 'sessionStorage'].forEach(function (name: string): void {
    try {
      const native = win[name] as Storage;
      native.setItem('__html_viewer_probe__', '1');
      native.removeItem('__html_viewer_probe__');
      return; // The real store works; leave it alone.
    } catch (error) { /* opaque origin or write denied: fall through */ }

    const map = new Map<string, string>();
    let reported = false;
    const touch = function (): void {
      if (reported) return;
      reported = true;
      tell(name, name + ' is blocked inside the sandboxed document, so a temporary in-memory ' + name +
        ' is used instead. It works while this page stays open but is not saved after reload or reopen.');
    };
    const methods: Record<string, unknown> = {
      getItem: function (key: unknown): string | null { touch(); const k = String(key); return map.has(k) ? (map.get(k) as string) : null; },
      setItem: function (key: unknown, value: unknown): void { touch(); map.set(String(key), String(value)); },
      removeItem: function (key: unknown): void { touch(); map.delete(String(key)); },
      clear: function (): void { touch(); map.clear(); },
      key: function (index: unknown): string | null {
        const keys = Array.from(map.keys());
        const i = Number(index);
        return i >= 0 && i < keys.length ? keys[i] : null;
      }
    };
    const has = Object.prototype.hasOwnProperty;
    const store = new Proxy({}, {
      get: function (_target: object, prop: string | symbol): unknown {
        if (prop === Symbol.toStringTag) return 'Storage';
        if (typeof prop !== 'string') return undefined;
        if (prop === 'length') return map.size;
        if (has.call(methods, prop)) return methods[prop];
        return map.has(prop) ? map.get(prop) : undefined;
      },
      set: function (_target: object, prop: string | symbol, value: unknown): boolean {
        if (typeof prop === 'string') { touch(); map.set(prop, String(value)); }
        return true;
      },
      deleteProperty: function (_target: object, prop: string | symbol): boolean {
        if (typeof prop === 'string') map.delete(prop);
        return true;
      },
      has: function (_target: object, prop: string | symbol): boolean {
        return typeof prop === 'string' && (prop === 'length' || has.call(methods, prop) || map.has(prop));
      },
      ownKeys: function (): string[] { return Array.from(map.keys()); },
      getOwnPropertyDescriptor: function (_target: object, prop: string | symbol): PropertyDescriptor | undefined {
        return typeof prop === 'string' && map.has(prop)
          ? { value: map.get(prop), writable: true, enumerable: true, configurable: true } : undefined;
      }
    });
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return store; } });
    } catch (error) {
      tell(name, 'Could not install an in-memory ' + name + ' fallback; scripts that use it will fail inside the sandbox.');
    }
  });
}

export function getStorageShimScript(token = ''): string {
  return `(${installStorageFallback.toString()})(${JSON.stringify(token).replace(/</g, '\\u003c')});`;
}
