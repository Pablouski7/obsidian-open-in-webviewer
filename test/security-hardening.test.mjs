// Synthetic regressions for the independent review findings (navigation, external links, output budget,
// empty/xlink hrefs, main-document size, VaultResources allowlists, desktop control characters).
// Everything is invented; no vault, credentials or private HTML is read. The browser tests run Chromium WITH its
// sandbox; the desktop test runs the server in a CHILD process so a regression cannot kill the test runner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { startHarness, until, sleep, runtimeRoot } from './browser-harness.mjs';
import { browserTestBuildOptions } from '../esbuild.shared.mjs';

let h;
const V = 'src/vendor/style-html-viewer/src';
before(async () => {
	h = await startHarness();
	fs.mkdirSync(runtimeRoot, { recursive: true });
	const out = path.join(runtimeRoot, `sec-${process.pid}.js`);
	await build(browserTestBuildOptions({
		stdin: {
			contents: `import * as seam from './test/renderer-seam';
import { resolveHtmlAssets, MAX_OUTPUT_CHARS } from './${V}/engine/HtmlAssetResolver';
import { VaultResources, MAX_ASSET_BYTES } from './${V}/preview/VaultResources';
import { getClickInterceptorScript } from './${V}/ipc/IpcBridge';
import { rememberFragment, pendingFragmentCount } from './${V}/preview/PreviewPanel';
window.sec = { seam, resolveHtmlAssets, MAX_OUTPUT_CHARS, VaultResources, MAX_ASSET_BYTES, getClickInterceptorScript, rememberFragment, pendingFragmentCount };`,
			resolveDir: process.cwd(),
		},
		outfile: out,
		alias: { obsidian: path.resolve('test/renderer-seam.ts') },
	}));
	await h.evaluate(fs.readFileSync(out, 'utf8') + '\n;true');
	fs.rmSync(out, { force: true });
});
after(async () => { await h?.stop(); });

const png = (bytes) => ({ b64: Buffer.alloc(bytes, 7).toString('base64') });
const SIBLING = '<h1>S</h1><div style="height:3000px"></div><h2 id="sec">Sec</h2>';
const token = (ctx) => h.evaluate('document.querySelector("script[nonce]").nonce', ctx);
const diagnosticsText = async () => {
	await h.clickHost('button[aria-label="More actions"]');
	await h.clickHost('[role=menuitem][data-action="diagnostics"]');
	const text = await h.evaluate('document.querySelector("[role=dialog]").textContent');
	await h.clickHost('[role=dialog] button[aria-label="Close"]');
	return text;
};
/** Posts messages from the document, one per tick so per-frame (not per-task) limits are exercised. */
/** Runs a promise-returning expression and polls for its result (the harness's replMode does not await promises). */
const evalAsync = async (expression, ctx) => {
	const key = '__r' + Math.random().toString(36).slice(2);
	await h.evaluate(`window.${key} = null; (${expression}).then(v => { window.${key} = { v }; }, e => { window.${key} = { e: String((e && e.message) || e) }; }); true`, ctx);
	const r = await until(() => h.evaluate(`window.${key}`, ctx), 'async result');
	if ('e' in r) throw new Error(r.e);
	return r.v;
};
/** One message whose handling replaces the frame: do not poll the (destroyed) context afterwards. */
const postOnce = (ctx, tok, message) => h.evaluate(`parent.postMessage({ ...${JSON.stringify(message)}, token: ${JSON.stringify(tok)} }, '*'); true`, ctx);
const postMany =(ctx, tok, messages) => evalAsync(`(async () => { for (const m of ${JSON.stringify(messages)}) { parent.postMessage({ ...m, token: ${JSON.stringify(tok)} }, '*'); await new Promise(r => setTimeout(r, 15)); } })()`, ctx);

// ------------------------------------------------------------------ 1. navigation

test('navigation: unresolved, hidden, configDir and non-document targets are never opened or created', async () => {
	const ctx = await h.load('<a id="dead" href="missing.html">dead</a>', {
		'sibling/sibling.html': SIBLING, 'quiz/.hid/x.html': '<p>h</p>', 'notes/n.md': '# n', 'quiz/data.txt': 'x',
		'cfg/p.json': '{}', 'quiz/.obsidian/a.json': '{}', '.git/c.html': '<p>g</p>'
	}, { setup: 'app.vault.configDir = "cfg"; app.workspace.createdNotes.length = 0; app.workspace.leafOpens.length = 0' });
	await h.clickFrame('#dead', ctx);
	const tok = await token(ctx);
	await postMany(ctx, tok, [
		'missing.html', '.hid/x.html', '../notes/n.md', 'data.txt', '../cfg/p.json', '.obsidian/a.json', '../.git/c.html', '..%2F..%2Fx.html', '%00.html', 'nested/none.json',
	].map((linkText) => ({ type: 'obsidian-navigate', linkText, newLeaf: true })));
	await sleep(150);
	assert.deepEqual(await h.evaluate('app.workspace.createdNotes'), []);
	assert.deepEqual(await h.evaluate('app.workspace.leafOpens'), []);
	assert.deepEqual(await h.evaluate('app.workspace.openedLinks'), []);
	assert.equal(await h.evaluate('view.file.path'), 'quiz/index.html');
	assert.match(await diagnosticsText(), /not an existing HTML or JSON file/);
});

test('navigation: an existing html file opens through leaf.openFile (no openLinkText), json too', async () => {
	const ctx = await h.load('<a id="ok" href="../sibling/sibling.html">s</a>', { 'sibling/sibling.html': SIBLING, 'sibling/d.json': '{"a":1}' });
	await h.evaluate('app.workspace.createdNotes.length = 0; app.workspace.leafRequests.length = 0; true');
	await h.clickFrame('#ok', ctx);
	await until(() => h.evaluate('view.file.path === "sibling/sibling.html"'), 'opened');
	assert.deepEqual(await h.evaluate('app.workspace.leafRequests'), [false]);
	assert.deepEqual(await h.evaluate('app.workspace.createdNotes'), []);
	const ctx2 = await h.frame({ ready: (n) => h.evaluate('!!document.querySelector("h1")', n) });
	await postOnce(ctx2, await token(ctx2), { type: 'obsidian-navigate', linkText: 'd.json' });
	await until(() => h.evaluate('view.file.path === "sibling/d.json"'), 'json opened');
});

test('navigation: messages per frame are bounded (flood of existing and unresolved links, new-leaf requests)', async () => {
	let ctx = await h.load('<p>x</p>', { 'sibling/sibling.html': SIBLING });
	// A flood in one task opens at most one document.
	await h.evaluate('app.workspace.leafOpens.length = 0; true');
	const tok = await token(ctx);
	await h.evaluate(`for (let i = 0; i < 500; i++) { parent.postMessage({ type: 'obsidian-navigate', linkText: '../sibling/sibling.html', newLeaf: true, token: ${JSON.stringify(tok)} }, '*'); } true`, ctx);
	await sleep(250);
	assert.equal(await h.evaluate('app.workspace.leafOpens.length'), 1);
	assert.equal(await h.evaluate('app.workspace.leafOpens[0].how'), 'tab');
	// Unresolved flood: nothing created, and the host reports once that it stopped listening.
	ctx = await h.load('<p>x</p>', { 'sibling/sibling.html': SIBLING });
	const tok2 = await token(ctx);
	await h.evaluate(`for (let i = 0; i < 500; i++) parent.postMessage({ type: 'obsidian-navigate', linkText: 'spam' + i, newLeaf: true, token: ${JSON.stringify(tok2)} }, '*'); true`, ctx);
	await sleep(250);
	assert.deepEqual(await h.evaluate('app.workspace.createdNotes'), []);
	assert.deepEqual(await h.evaluate('app.workspace.leafOpens'), []);
	assert.match(await diagnosticsText(), /Too many link requests/);
	// New tabs and total opens are capped even when each open completes (the frame stays alive here).
	ctx = await h.load('<p>x</p>', { 'sibling/sibling.html': SIBLING });
	await h.evaluate('app.workspace.leaf.openFile = async (f) => { app.workspace.leafOpens.push({ path: f.path, how: app.workspace.lastLeafHow }); }; app.workspace.leafOpens.length = 0; true');
	const tok3 = await token(ctx);
	await postMany(ctx, tok3, Array.from({ length: 10 }, () => ({ type: 'obsidian-navigate', linkText: '../sibling/sibling.html', newLeaf: true })));
	const tabs = await h.evaluate('app.workspace.leafOpens.filter(o => o.how === "tab").length');
	assert.ok(tabs >= 1 && tabs <= 3, `new tabs requested by one document: ${tabs} (limit 3)`);
	await postMany(ctx, tok3, Array.from({ length: 60 }, () => ({ type: 'obsidian-navigate', linkText: '../sibling/sibling.html' })));
	assert.ok((await h.evaluate('app.workspace.leafOpens.length')) <= 30, 'at most 30 link requests per document');
});

test('navigation: same-file #fragment scrolls inside the frame, no reload or open', async () => {
	const ctx = await h.load('<a id="self" href="index.html#sec">self</a><div style="height:3000px"></div><div id="sec">sec</div>');
	await h.evaluate('app.workspace.leafOpens.length = 0; window.view.__marker = 1; true');
	await h.evaluate('window.__m = 7; true', ctx);
	await h.clickFrame('#self', ctx);
	await until(() => h.evaluate('window.scrollY > 100', ctx), 'scrolled in frame');
	assert.equal(await h.evaluate('window.__m', ctx), 7, 'same live document');
	assert.equal(await h.evaluate('location.hash', ctx), '#sec');
	assert.deepEqual(await h.evaluate('app.workspace.leafOpens'), []);
	assert.equal(await h.evaluate('window.view.__marker'), 1);
});

test('navigation: fragment reaches the opened document; failed opens and non-targets leave nothing pending', async () => {
	let ctx = await h.load('<p>x</p>', { 'sibling/sibling.html': SIBLING });
	await postOnce(ctx, await token(ctx), { type: 'obsidian-navigate', linkText: '../sibling/sibling.html#sec' });
	await until(() => h.evaluate('view.file.path === "sibling/sibling.html"'), 'opened');
	ctx = await h.frame({ ready: (n) => h.evaluate('location.hash === "#sec"', n) });
	// Failed open: the recorded fragment is dropped, a later plain open does not scroll.
	ctx = await h.load('<p>x</p>', { 'sibling/sibling.html': SIBLING });
	await h.evaluate('app.workspace.leaf.openFile = () => Promise.reject(new Error("boom")); true');
	await postMany(ctx, await token(ctx), [{ type: 'obsidian-navigate', linkText: '../sibling/sibling.html#sec' }]);
	await sleep(150);
	await h.evaluate('delete app.workspace.leaf.openFile; app.workspace.openFile("sibling/sibling.html")');
	ctx = await h.frame({ ready: (n) => h.evaluate('!!document.querySelector("h1")', n) });
	await sleep(150);
	assert.equal(await h.evaluate('location.hash', ctx), '');
	// Dead link with a fragment never records one.
	ctx = await h.load('<p>x</p>', { 'sibling/sibling.html': SIBLING });
	await postMany(ctx, await token(ctx), [{ type: 'obsidian-navigate', linkText: '../sibling/nope.html#sec' }]);
	await sleep(100);
	await h.evaluate('app.workspace.openFile("sibling/sibling.html")');
	ctx = await h.frame({ ready: (n) => h.evaluate('!!document.querySelector("h1")', n) });
	await sleep(150);
	assert.equal(await h.evaluate('location.hash', ctx), '');
});

test('navigation: pendingFragments is bounded', async () => {
	assert.equal(await h.evaluate('(() => { for (let i = 0; i < 500; i++) sec.rememberFragment("p" + i + ".html", "f" + i); return sec.pendingFragmentCount(); })()'), 8);
});

// ------------------------------------------------------------------ 2. external links

test('external: the host never calls window.open; a bounded Notice shows the URL', async () => {
	let ctx = await h.load('<a id="ext" href="https://example.com/?q=1">x</a>');
	await h.evaluate('window.__opened = []; window.open = (...a) => { __opened.push(a); return null; }; true');
	await h.clickFrame('#ext', ctx);
	await until(() => h.evaluate('window.notices.length === 1'), 'notice');
	assert.match(await h.evaluate('window.notices[0]'), /https:\/\/example\.com\/\?q=1/);
	assert.equal(await h.evaluate('__opened.length'), 0);
	// A script cannot open anything by posting directly, and a flood is throttled.
	ctx = await h.load('<p>x</p>');
	await h.evaluate('window.__opened = []; window.open = (...a) => { __opened.push(a); return null; }; true');
	const tok = await token(ctx);
	await h.evaluate(`for (let i = 0; i < 200; i++) parent.postMessage({ type: 'obsidian-open-external', url: 'https://evil.example/?d=' + i, token: ${JSON.stringify(tok)} }, '*'); parent.postMessage({ type: 'obsidian-open-external', url: 'javascript:alert(1)', token: ${JSON.stringify(tok)} }, '*'); true`, ctx);
	await sleep(250);
	assert.equal(await h.evaluate('__opened.length'), 0);
	assert.equal(await h.evaluate('window.notices.length'), 1, 'throttled to one notice, none for javascript:');
	assert.ok((await h.evaluate('window.notices[0].length')) < 400);
});

// ------------------------------------------------------------------ 3. wording

test('wording: no source claims the reader has "no network access"; the remote-stylesheet diagnostic stays accurate', async () => {
	const stack = [`${V}`, 'src/desktop-server.ts', 'src/mobile-view.ts', 'main.ts'];
	const files = [];
	const walk = (p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).forEach((n) => walk(path.join(p, n))) : files.push(p);
	stack.forEach(walk);
	for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /no network access/i, f);
	const r = await evalAsync(`(async () => (await sec.resolveHtmlAssets({ rawHtml: '<link rel=stylesheet href="https://fonts.example/x.css">', currentFileFolderPath: '', getResourcePathFn: async () => '' })).diagnostics)()`);
	assert.match(r[0].message, /Remote stylesheet blocked/);
	assert.doesNotMatch(r[0].message, /network/i);
});

// ------------------------------------------------------------------ 4. output budget

const resolveIn = (files, rawHtml, maxOutputChars) => evalAsync(`(async () => {
	const v = new sec.seam.Vault(); Object.assign(v.files, ${JSON.stringify(files)});
	const res = new sec.VaultResources(v);
	const out = await sec.resolveHtmlAssets({ rawHtml: ${JSON.stringify(rawHtml)}, currentFileFolderPath: '', getResourcePathFn: p => res.dataUrl(p), readVaultFileFn: p => res.readText(p), ${maxOutputChars ? 'maxOutputChars: ' + maxOutputChars + ',' : ''} });
	return { length: out.transformedHtml.length, diagnostics: out.diagnostics, imgs: (out.transformedHtml.match(/<img[^>]* src=/g) || []).length, scripts: (out.transformedHtml.match(/repeated-marker/g) || []).length };
})()`);

test('output budget: the default is 16 MiB of characters', async () => {
	assert.equal(await h.evaluate('sec.MAX_OUTPUT_CHARS'), 16 * 1024 * 1024);
});

test('output budget: one admitted image referenced hundreds of times is charged per occurrence', async () => {
	const html = Array.from({ length: 200 }, () => '<img src="big.png">').join('') + '<div style="background:url(big.png)"></div>'.repeat(10);
	// The viewer's own script and the framing are reserved first; ~4 KB per image copy is what remains.
	const r = await resolveIn({ 'big.png': png(3000) }, html, 120000);
	assert.ok(r.length <= 120000, `emitted ${r.length}`);
	assert.ok(r.imgs > 0 && r.imgs < 40, `images kept: ${r.imgs}; script ${await h.evaluate('sec.getClickInterceptorScript("t","").length')}; length ${r.length}; ${JSON.stringify(r.diagnostics.slice(0, 3))}`);
	assert.ok(r.diagnostics.some((d) => /Output budget exceeded/.test(d.message)));
	// Unbounded behaviour for comparison: the same document within a big budget keeps everything.
	const all = await resolveIn({ 'big.png': png(3000) }, html, 5 * 1024 * 1024);
	assert.equal(all.imgs, 200);
	assert.ok(all.length > 800000);
});

test('output budget: repeated stylesheets and scripts are charged per occurrence', async () => {
	const css = 'a{color:red}/* ' + 'x'.repeat(2000) + ' */';
	const js = 'window.q=1;/* repeated-marker ' + 'y'.repeat(2000) + ' */';
	const links = Array.from({ length: 150 }, () => '<link rel=stylesheet href="s.css">').join('');
	const scripts = Array.from({ length: 150 }, () => '<script src="a.js"></script>').join('');
	const r1 = await resolveIn({ 's.css': css }, links, 50000);
	assert.ok(r1.length <= 50000, `css emitted ${r1.length}`);
	assert.ok(r1.diagnostics.some((d) => /Output budget exceeded/.test(d.message)));
	const r2 = await resolveIn({ 'a.js': js }, scripts, 50000);
	assert.ok(r2.length <= 50000 && r2.scripts < 30, `js emitted ${r2.length}, copies ${r2.scripts}`);
	assert.ok(r2.diagnostics.some((d) => /Output budget exceeded/.test(d.message)));
});

test('output budget: a document larger than the budget fails before anything is inserted', async () => {
	await assert.rejects(resolveIn({}, '<p>' + 'x'.repeat(1000) + '</p>', 500), /Output budget exceeded/);
});

// ------------------------------------------------------------------ 5. empty / xlink hrefs

test('hrefs: empty, whitespace, SVG xlink:href, #top, encoded and named anchors never navigate the frame; authored handlers still run', async () => {
	const doc = `<a id="e1" href="">empty</a> <a id="e2" href="   ">ws</a> <a id="tp" href="#top">top</a> <a id="enc" href="#caf%C3%A9">enc</a>
<a id="nm" href="#named">named</a> <a id="au" href="#sec" onclick="window.__authored=(window.__authored||0)+1">auth</a>
<svg width="120" height="30"><a id="sv" xlink:href="#sec"><rect width="120" height="30" fill="red"></rect><text x="5" y="20">x</text></a></svg>
<svg width="120" height="30"><a id="sv2" xlink:href=""><rect width="120" height="30" fill="blue"></rect></a></svg>
<map name="m"><area id="ar" shape="rect" coords="0,0,5,5" href=""></map>
<div style="height:2000px"></div><div id="café">c</div><a name="named">n</a><div id="sec">sec</div>`;
	const ctx = await h.load(doc);
	await h.evaluate('window.__m = 42; true', ctx);
	for (const id of ['e1', 'e2', 'tp', 'enc', 'nm', 'au', 'sv', 'sv2']) {
		await h.evaluate('window.scrollTo(0, 0)', ctx);
		await h.clickFrame('#' + id, ctx);
		await sleep(120);
		assert.equal(await h.evaluate('window.__m', ctx), 42, `${id}: document survived`);
		// "#top" may legitimately set the hash; the document itself must stay about:srcdoc.
		assert.match(await h.evaluate('location.href', ctx), /^about:srcdoc(#.*)?$/, id);
	}
	assert.equal(await h.evaluate('window.__authored', ctx), 1, 'authored handler ran');
	// Empty href means "top", like a browser.
	await h.evaluate('window.scrollTo(0, 800); true', ctx);
	await h.evaluate('document.getElementById("e1").click(); true', ctx);
	await until(() => h.evaluate('window.scrollY === 0', ctx), 'scrolled to top');
	// Encoded id scrolls to the target.
	await h.evaluate('window.scrollTo(0, 0); document.getElementById("enc").click(); true', ctx);
	await until(() => h.evaluate('window.scrollY > 100', ctx), 'encoded anchor scrolled');
	// area[href=""] is intercepted as well (no native navigation).
	await h.evaluate('document.getElementById("ar").click(); true', ctx);
	await sleep(100);
	assert.equal(await h.evaluate('window.__m', ctx), 42);
	assert.equal(await h.evaluate('app.workspace.leafOpens.length'), 0);
});

test('serialized runtime: U+2028/2029 in a fragment cannot break the script', async () => {
	const script = await h.evaluate('sec.getClickInterceptorScript("t", "a\\u2028b\\u2029c")');
	assert.ok(!script.includes(' ') && !script.includes(' '));
	assert.doesNotThrow(() => new Function(script));
	assert.doesNotMatch(script, /__\w+\(/, 'no esbuild helper references in the serialized runtime');
});

// ------------------------------------------------------------------ 6. main document size

test('main document: recorded size is checked BEFORE vault.read, actual text afterwards', async () => {
	await h.load('<p>ok</p>');
	let n = 0;
	// Each case uses a NEW path (re-opening the open file is a no-op) and waits for the title of that very file
	// plus its own message, so a previous error card can never satisfy the wait.
	const open = async (ext, text, size, expected) => {
		const file = `big/case${++n}.${ext}`;
		await h.evaluate(`(() => { app.vault.files[${JSON.stringify(file)}] = ${text}; app.vault.sizes[${JSON.stringify(file)}] = ${size}; app.vault.reads.length = 0; app.workspace.openFile(${JSON.stringify(file)}); return true; })()`);
		await until(async () => (await h.evaluate('view.file && view.file.path')) === file && expected.test(await h.evaluate('document.querySelector(".html-viewer-error-message")?.textContent || ""')), `error for ${file}`);
		return { file, reads: await h.evaluate('app.vault.reads') };
	};
	for (const ext of ['html', 'json']) {
		let r = await open(ext, '"<p>x</p>"', '11 * 1024 * 1024', /10 MB/);
		assert.deepEqual(r.reads, [], 'not read');
		r = await open(ext, '"<p>x</p>"', 'NaN', /size is unavailable/);
		assert.deepEqual(r.reads, []);
		r = await open(ext, '"<p>x</p>"', 'Infinity', /10 MB|unavailable/);
		assert.deepEqual(r.reads, []);
		r = await open(ext, '"x".repeat(10 * 1024 * 1024 + 1)', '10', /10 MB/);
		assert.deepEqual(r.reads, [r.file], 'read, then rejected on actual length');
	}
});

// ------------------------------------------------------------------ 7. VaultResources

const vaultCase = (setup, body) => evalAsync(`(async () => {
	const seam = sec.seam; const entries = {};
	const file = (p, o = {}) => { const f = new seam.TFile(p, o.size ?? 10); if ('extension' in o) f.extension = o.extension; if ('stat' in o) f.stat = o.stat; entries[p] = { f, data: o.data ?? new TextEncoder().encode('abc').buffer, text: o.text ?? 'abc' }; };
	${setup}
	const vault = { configDir: '.obsidian', getAbstractFileByPath: p => entries[p]?.f ?? null, read: async f => (entries[f.path].text), readBinary: async f => entries[f.path].data };
	const run = async (name, fn) => { try { return { ok: await fn() }; } catch (e) { return { error: String(e.message) }; } };
	${body}
})()`);

test('VaultResources: real extension required, binary-only data URLs, configDir denied, fail closed, actual size rechecked', async () => {
	const r = await vaultCase(`
		file('js'); file('png', { extension: '' }); file('a.png', { extension: '' }); file('x.js'); file('x.css'); file('a.png2', { extension: 'png' });
		file('ok.png'); file('ok.css'); file('ok.js'); file('s.vtt'); file('notes.json'); file('cfg/p.js'); file('.obsidian/p.js');
		file('nostat.png', { stat: undefined }); file('nan.png', { stat: { size: NaN } }); file('neg.png', { stat: { size: -1 } });
		file('lie.png', { size: 1 }); entries['lie.png'].data = new ArrayBuffer(11 * 1024 * 1024);
		file('g1.png', { size: 1 }); entries['g1.png'].data = new ArrayBuffer(6 * 1024 * 1024);
		file('g2.png', { size: 1 }); entries['g2.png'].data = new ArrayBuffer(6 * 1024 * 1024);
		file('lie.css', { size: 1 }); entries['lie.css'].text = 'x'.repeat(10 * 1024 * 1024 + 1);
	`, `
		vault.configDir = 'cfg';
		const a = new sec.VaultResources(vault);
		const out = {};
		for (const p of ['js', 'png', 'a.png', 'a.png2', 'x.js', 'x.css', 'ok.png', 's.vtt', 'notes.json', 'cfg/p.js', '.obsidian/p.js', 'nostat.png', 'nan.png', 'neg.png', 'lie.png']) out['data:' + p] = (await run(p, () => a.dataUrl(p)));
		for (const p of ['ok.css', 'ok.js', 'x.js', 'ok.png', 'notes.json', 'js', 'cfg/p.js', 'lie.css']) out['text:' + p] = (await run(p, () => a.readText(p)));
		const b = new sec.VaultResources(vault);
		out.g1 = await run('g1', () => b.dataUrl('g1.png'));
		out.g2 = await run('g2', () => b.dataUrl('g2.png'));
		return out;
	`);
	const ok = (k) => assert.ok('ok' in r[k], `${k}: ${JSON.stringify(r[k])}`);
	const no = (k, re) => { assert.ok('error' in r[k], `${k} should be refused`); if (re) assert.match(r[k].error, re, k); };
	ok('data:ok.png'); ok('data:s.vtt'); ok('data:a.png2');
	assert.match(r['data:ok.png'].ok, /^data:image\/png;base64,/);
	no('data:js', /type/); no('data:png', /type/); no('data:a.png', /type/);
	no('data:x.js', /type/); no('data:x.css', /type/); no('data:notes.json', /type/);
	no('data:cfg/p.js', /configuration/); no('data:.obsidian/p.js', /Hidden/);
	no('data:nostat.png', /size is unavailable/); no('data:nan.png', /size is unavailable/); no('data:neg.png', /size is unavailable/);
	no('data:lie.png', /per-file limit/);
	ok('text:ok.css'); ok('text:ok.js'); ok('text:x.js');
	no('text:ok.png', /type/); no('text:notes.json', /type/); no('text:js', /type/); no('text:cfg/p.js', /configuration/);
	no('text:lie.css', /per-file limit/);
	ok('g1'); no('g2', /budget exceeded/);
});

test('VaultResources: concurrent oversize reads cannot exceed the budget', async () => {
	const r = await vaultCase(`for (let i = 0; i < 6; i++) { file('i' + i + '.png', { size: 3 * 1024 * 1024 }); entries['i' + i + '.png'].data = new ArrayBuffer(3 * 1024 * 1024); }`, `
		const a = new sec.VaultResources(vault);
		const results = await Promise.all([0, 1, 2, 3, 4, 5].map(i => run('i' + i, () => a.dataUrl('i' + i + '.png'))));
		return results.filter(x => 'ok' in x).length;
	`);
	assert.equal(r, 3);
});

// ------------------------------------------------------------------ 8. desktop control characters

test('desktop: decoded NUL/control characters get HTTP 400 before any fs call; the server survives (child process)', async () => {
	fs.mkdirSync('.test-runtime', { recursive: true });
	const root = fs.mkdtempSync(path.resolve('.test-runtime/ctl-'));
	fs.writeFileSync(path.join(root, 'ok.html'), 'fine');
	const code = `const { startDesktopServer } = await import(process.argv[2]); const s = await startDesktopServer(process.argv[1]); process.stdout.write('PORT ' + s.port + '\\n'); process.on('uncaughtException', e => { process.stdout.write('UNCAUGHT ' + e.code + '\\n'); process.exit(3); }); setInterval(() => {}, 1000);`;
	const child = spawn(process.execPath, ['--input-type=module', '-e', code, root, pathToFileURL(path.resolve('dist/desktop-server.js')).href], { stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout.on('data', (d) => { out += d; });
	try {
		const port = await until(() => /PORT (\d+)/.exec(out)?.[1], 'child server');
		const get = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
		for (const p of ['/%00', '/ok.html%00', '/a%00b.html', '/%01', '/%1f.html', '/%7f', '/%0a', '/%0d%0a', '/x%00/../ok.html']) assert.equal(await get(p), 400, p);
		assert.equal(await get('/ok.html'), 200);
		assert.equal(await get('/%zz'), 400);
		assert.equal(child.exitCode, null, 'child still running');
		assert.doesNotMatch(out, /UNCAUGHT/);
	} finally {
		child.kill();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
