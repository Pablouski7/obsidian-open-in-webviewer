// Adapted from taihoe/style-html-viewer v1.0.6 (708c18c). Local changes are marked "LOCAL" and listed in ../../NOTICE.md.
import { TFile, Vault } from 'obsidian';
import { isHiddenPath } from '../../../../security';

/** LOCAL: binary-only types that may become data: URLs. Scripts and stylesheets go through readText, never here. */
const binaryMimeTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  vtt: 'text/vtt'
};
/** LOCAL: text a document may pull in through the engine (stylesheets, @imports, classic/module scripts). */
const textExtensions = new Set(['css', 'js', 'mjs']);

/**
 * LOCAL: resources are bounded for phones. Upstream allowed 32 MB per file and 100 MB in total and only noticed
 * after the bytes were already in memory. Here the budget is spent from the file's recorded size BEFORE any read,
 * so concurrent requests (srcset candidates, many images) cannot allocate past it, and any growth beyond the
 * recorded size is reserved (or refused) as soon as the real size is known.
 */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_ASSET_COUNT = 256;
/** The main html/json document is bounded the same way. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const mib = (bytes: number) => (bytes / 1048576).toFixed(1);

/** Embed assets through the vault API; opaque frames never receive filesystem privileges. */
export class VaultResources {
  private reservedBytes = 0;
  private assetCount = 0;
  private readonly reservations = new Map<string, number>();
  private readonly text = new Map<string, Promise<string>>();
  private readonly data = new Map<string, Promise<string>>();
  constructor(private vault: Vault) {}

  private isConfigPath(path: string): boolean {
    const configured = (this.vault as { configDir?: unknown }).configDir;
    const dir = (typeof configured === 'string' && configured ? configured : '.obsidian').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
    const lower = path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    return lower === dir || lower.startsWith(dir + '/');
  }

  /** Every refusal in this method happens before the vault is asked to read anything. */
  private admit(path: string, allowed: (extension: string) => boolean, what: string): TFile {
    // LOCAL: documents are untrusted. Dot-folders hold Obsidian settings, plugin data (which can contain tokens)
    // and VCS metadata; they are never made available to a document, however the path is spelled. A custom
    // "override config folder" (any name) is denied too.
    if (isHiddenPath(path) || this.isConfigPath(path)) throw new Error(`Hidden or configuration path is not available to documents: ${path}`);
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`File not found: ${path}`);
    if (isHiddenPath(file.path) || this.isConfigPath(file.path)) throw new Error(`Hidden or configuration path is not available to documents: ${path}`);
    // LOCAL: allowlist by the file's REAL extension (not the spelling of the request), so a document cannot read
    // notes, JSON or other data through an asset reference, and an extension-less file named "js" is not a script.
    const extension = typeof file.extension === 'string' ? file.extension.toLowerCase() : '';
    if (!extension || !allowed(extension)) throw new Error(`File type ".${extension}" cannot be used as ${what}: ${path}`);
    // Fail closed: a missing or invalid recorded size is not treated as zero.
    const size = file.stat?.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) throw new Error(`File size is unavailable; not loading ${path}`);
    if (size > MAX_ASSET_BYTES) throw new Error(`Asset is ${mib(size)} MiB, over the ${MAX_ASSET_BYTES / 1048576} MiB per-file limit: ${path}`);
    if (this.assetCount + 1 > MAX_ASSET_COUNT) throw new Error(`Too many assets (limit ${MAX_ASSET_COUNT}); not loading ${path}`);
    if (this.reservedBytes + size > MAX_ASSET_BYTES) {
      throw new Error(`Asset budget exceeded: ${path} (${mib(size)} MiB) would take this document past ${MAX_ASSET_BYTES / 1048576} MiB of local files`);
    }
    // Spend synchronously: concurrent callers observe the updated total before any of them awaits.
    this.assetCount++;
    this.reservedBytes += size;
    this.reservations.set(path, size);
    return file;
  }

  /** After a read: the real size may differ from the recorded one (the file changed in between). */
  private settle(path: string, actual: number): void {
    const reserved = this.reservations.get(path) ?? 0;
    if (actual > MAX_ASSET_BYTES) throw new Error(`Asset is ${mib(actual)} MiB, over the ${MAX_ASSET_BYTES / 1048576} MiB per-file limit: ${path}`);
    const growth = actual - reserved;
    if (growth > 0) {
      if (this.reservedBytes + growth > MAX_ASSET_BYTES) throw new Error(`Asset budget exceeded: ${path} grew while it was being read`);
      this.reservedBytes += growth;
      this.reservations.set(path, actual);
    }
  }

  public readText(path: string): Promise<string> {
    let cached = this.text.get(path);
    if (!cached) {
      cached = Promise.resolve().then(async () => {
        const text = await this.vault.read(this.admit(path, extension => textExtensions.has(extension), 'a stylesheet or script (only .css and .js)'));
        this.settle(path, text.length);
        return text;
      });
      this.text.set(path, cached);
    }
    return cached;
  }

  public dataUrl(path: string): Promise<string> {
    let cached = this.data.get(path);
    if (!cached) {
      cached = Promise.resolve().then(async () => {
        const file = this.admit(path, extension => Object.prototype.hasOwnProperty.call(binaryMimeTypes, extension), 'an image, font, audio, video or subtitle asset');
        const buffer = await this.vault.readBinary(file);
        this.settle(path, buffer.byteLength);
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        return `data:${binaryMimeTypes[file.extension.toLowerCase()]};base64,${btoa(binary)}`;
      });
      this.data.set(path, cached);
    }
    return cached;
  }
}
