/** Split before decoding so encoded filename characters are not mistaken for URL delimiters. */
export function splitUrl(url: string): { path: string; suffix: string } {
  const index = url.search(/[?#]/);
  return index < 0 ? { path: url, suffix: '' } : { path: url.slice(0, index), suffix: url.slice(index) };
}

export function folderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

export function isSpecialUrl(url: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#|\?)/i.test(url.trim());
}

/** Resolve URL path segments inside the vault. Traversal above the root is rejected. */
export function resolveVaultPath(folder: string, urlPath: string): string {
  const decoded = decodeURIComponent(urlPath.trim()).replace(/\\/g, '/');
  if (Array.from(decoded).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//')) {
    throw new Error('Invalid vault path');
  }
  const parts = decoded.startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('Path leaves the vault');
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  if (!parts.length) throw new Error('Empty vault path');
  return parts.join('/');
}

/** The HTML srcset tokenizer keeps commas within URLs (including data URLs). */
export function parseSrcset(value: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\t\n\f\r ,]/.test(value[index])) index++;
    const start = index;
    while (index < value.length && !/[\t\n\f\r ]/.test(value[index])) index++;
    let url = value.slice(start, index);
    if (!url) break;
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
      candidates.push({ url, descriptor: '' });
      continue;
    }
    const descriptorStart = index;
    let depth = 0;
    while (index < value.length) {
      if (value[index] === '(') depth++;
      if (value[index] === ')') depth--;
      if (value[index] === ',' && depth === 0) break;
      index++;
    }
    candidates.push({ url, descriptor: value.slice(descriptorStart, index).trim() });
    index++;
  }
  return candidates;
}
