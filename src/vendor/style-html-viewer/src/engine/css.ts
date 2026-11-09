import postcss, { AtRule, Root } from 'postcss';
import valueParser from 'postcss-value-parser';
import { folderOf, isSpecialUrl, resolveVaultPath, splitUrl } from './paths';

export interface CssContext {
  resolveAsset: (url: string, folder: string) => Promise<string>;
  readStylesheet: (path: string) => Promise<string>;
  report: (path: string, message: string) => void;
}

/** Decode CSS escapes before applying URL/path validation. */
function unescapeCss(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})\s?|(\r\n|[\n\r\f])|(.))/gi, (_, hex: string, newline: string, char: string) => {
    if (hex) {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    }
    return newline ? '' : char;
  });
}

export async function rewriteCssValue(value: string, folder: string, context: CssContext): Promise<string> {
  const parsed = valueParser(value);
  const jobs: Promise<void>[] = [];
  parsed.walk(node => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const raw = node.nodes.length === 1 && node.nodes[0].type === 'string'
      ? node.nodes[0].value : valueParser.stringify(node.nodes).trim();
    jobs.push(context.resolveAsset(unescapeCss(raw), folder).then(uri => {
      node.nodes = [{ type: 'string', quote: '"', value: uri.replace(/\\/g, '\\\\').replace(/"/g, '\\"'), sourceIndex: 0, sourceEndIndex: 0 }];
    }));
    return false;
  });
  await Promise.all(jobs);
  return parsed.toString();
}

/** Resolve imports relative to their own sheets, retaining layer/supports/media semantics. */
export async function resolveCss(
  text: string, path: string, context: CssContext, ancestors: string[] = []
): Promise<Root> {
  if (ancestors.includes(path) || ancestors.length >= 32) {
    context.report(path, 'Cyclic or excessively deep stylesheet import');
    return postcss.root();
  }
  const root = postcss.parse(text, { from: undefined });
  const jobs: Promise<void>[] = [];
  root.walkDecls(declaration => {
    // Absolute data/blob resources produced by recursive imports remain unchanged.
    jobs.push(rewriteCssValue(declaration.value, folderOf(path), context).then(value => { declaration.value = value; }));
  });
  await Promise.all(jobs);
  const imports: AtRule[] = [];
  root.walkAtRules(/^import$/i, rule => { imports.push(rule); });
  for (const rule of imports) {
    try {
      const params = valueParser(rule.params).nodes.filter(n => n.type !== 'space' && n.type !== 'comment');
      const first = params.shift();
      let url = '';
      if (first?.type === 'string') url = first.value;
      else if (first?.type === 'function' && first.value.toLowerCase() === 'url') {
        url = first.nodes.length === 1 ? first.nodes[0].value : valueParser.stringify(first.nodes);
      }
      url = unescapeCss(url);
      if (!url || isSpecialUrl(url)) throw new Error('Only local stylesheet imports are supported');
      const importedPath = resolveVaultPath(folderOf(path), splitUrl(url).path);
      const imported = await resolveCss(await context.readStylesheet(importedPath), importedPath, context, [...ancestors, path]);
      let layer: string | undefined;
      let supports: string | undefined;
      if (params[0]?.value.toLowerCase() === 'layer') {
        const node = params.shift()!;
        layer = node.type === 'function' ? valueParser.stringify(node.nodes) : '';
      }
      if (params[0]?.type === 'function' && params[0].value.toLowerCase() === 'supports') {
        supports = valueParser.stringify(params[0].nodes);
        params.shift();
      }
      const media = params.map(n => valueParser.stringify(n)).join(' ').trim();
      let replacement: Root | AtRule = imported;
      if (media) replacement = postcss.atRule({ name: 'media', params: media }).append(replacement.type === 'root' ? replacement.nodes : [replacement]);
      if (supports) replacement = postcss.atRule({ name: 'supports', params: supports.startsWith('(') ? supports : `(${supports})` }).append(replacement.type === 'root' ? replacement.nodes : [replacement]);
      if (layer !== undefined) replacement = postcss.atRule({ name: 'layer', params: layer }).append(replacement.type === 'root' ? replacement.nodes : [replacement]);
      // Imported declarations are already resolved in their original directory.
      rule.replaceWith(replacement.type === 'root' ? replacement.nodes : replacement);
    } catch (error) {
      context.report(path, `Stylesheet import failed: ${error instanceof Error ? error.message : String(error)}`);
      rule.remove();
    }
  }
  root.walkAtRules(/^charset$/i, rule => { rule.remove(); });
  return root;
}
