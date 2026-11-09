// End-to-end renderer tests: the REAL plugin entry (main.ts onload -> registerView /
// registerExtensions -> workspace.openFile), Style's resolver + PostCSS + IPC bridge +
// PreviewPanel, and a sandboxed iframe, all inside Chromium (with its sandbox on).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startHarness, until, sleep } from './browser-harness.mjs';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h?.stop(); });

const b64 = async (p) => ({ b64: (await fs.readFile(p)).toString('base64') });
const diagnosticsText = async () => {
	await h.clickHost('button[aria-label="More actions"]');
	await h.clickHost('[role=menuitem][data-action="diagnostics"]');
	const text = await h.evaluate('document.querySelector("[role=dialog]").textContent');
	await h.clickHost('[role=dialog] button[aria-label="Close"]');
	return text;
};
async function quizFiles() {
	const files = {};
	for (const p of ['quiz/style.css', 'quiz/quiz.js', 'sibling/sibling.html']) files[p] = await fs.readFile('test/fixtures/' + p, 'utf8');
	files['quiz/icon.png'] = await b64('test/fixtures/quiz/icon.png');
	files['quiz/data.json'] = await fs.readFile('test/fixtures/quiz/data.json', 'utf8');
	return files;
}

test('entry: main.ts registers ONE mobile view id and ONE html/htm/json handler, keeps command and menu', async () => {
	await h.load('<p>x</p>');
	assert.deepEqual(await h.evaluate('[...plugin.views.keys()]'), ['open-in-webviewer-mobile']);
	assert.deepEqual(await h.evaluate('plugin.extensions'), [{ exts: ['html', 'htm', 'json'], type: 'open-in-webviewer-mobile' }]);
	assert.deepEqual(await h.evaluate('plugin.commands.map(c => [c.id, c.name])'), [['open-active-file-in-webviewer', 'Open current file in Web Viewer']]);
	await h.evaluate('app.workspace.activeFile = app.vault.getFileByPath("quiz/index.html"); true');
	assert.equal(await h.evaluate('plugin.commands[0].checkCallback(true)'), true);
	const items = await h.evaluate(`(() => { const got = []; const menu = { addItem(cb) { const item = { setTitle(t) { this.t = t; return this; }, setIcon() { return this; }, onClick(f) { this.f = f; return this; } }; cb(item); got.push(item.t); } }; app.workspace.trigger('file-menu', menu, app.vault.getFileByPath('quiz/index.html')); return got; })()`);
	assert.deepEqual(items, ['Open in Web Viewer']);
	// The registered handler is the Style-based view (shared lifecycle), reached through the real factory.
	assert.equal(await h.evaluate('view.constructor.name'), 'MobileHtmlView');
	assert.equal(await h.evaluate('view.contentEl.matches(".html-viewer-container")'), true);
});

test('security: first CSP + bridge before authored script, base/meta CSP stripped, network and nested frames blocked, scripts still run', async () => {
	const ctx = await h.load(`<!-- <head> decoy --> <html><head><base href="https://evil.invalid/"><meta http-equiv="Content-Security-Policy" content="default-src *"><script>window.first=!!window.localStorage; window.violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push(e.violatedDirective)); fetch('http://127.0.0.1:1/blocked').catch(()=>{});</script></head><body><iframe src="https://evil.invalid/"></iframe><object data="x"></object><button onclick="localStorage.setItem('quiz','yes');this.textContent=localStorage.getItem('quiz')">Quiz</button></body></html>`);
	assert.equal(await h.evaluate('document.head.firstElementChild.httpEquiv', ctx), 'Content-Security-Policy');
	assert.match(await h.evaluate('document.head.firstElementChild.content', ctx), /default-src 'none'/);
	assert.equal(await h.evaluate('document.querySelectorAll("base, iframe, object, meta[content*=\\"default-src *\\"]").length', ctx), 0);
	assert.equal(await h.evaluate('window.first', ctx), true);
	await h.clickFrame('button', ctx);
	assert.equal(await h.evaluate('document.querySelector("button").textContent', ctx), 'yes');
	await until(() => h.evaluate('violations.includes("connect-src")', ctx), 'fetch blocked by CSP');
	assert.equal(await h.evaluate('document.querySelector("iframe").getAttribute("sandbox").split(/\\s+/).sort().join(" ")'), 'allow-modals allow-scripts');
	assert.match(await h.evaluate('document.querySelector("iframe").getAttribute("referrerpolicy")'), /no-referrer/);
});

test('security: host accepts bridge messages only from its own frame AND with the per-render token', async () => {
	const files = await quizFiles();
	const ctx = await h.load(await fs.readFile('test/fixtures/quiz/index.html', 'utf8'), files);
	const token = await h.evaluate('document.querySelector("script[nonce]").nonce', ctx);
	assert.match(token, /^[0-9a-f]{48}$/);
	await h.evaluate('app.workspace.openedLinks.length = 0; true');
	// 1. frame without token, 2. frame with a wrong token, 3. correct token but posted by the host window itself.
	await h.evaluate(`parent.postMessage({type: 'obsidian-navigate', linkText: '../sibling/sibling.html'}, '*'); parent.postMessage({type: 'obsidian-navigate', linkText: '../sibling/sibling.html', token: 'nope'}, '*'); true`, ctx);
	await h.evaluate(`window.postMessage({type: 'obsidian-navigate', linkText: '../sibling/sibling.html', token: ${JSON.stringify(token)}}, '*'); true`);
	await sleep(250);
	assert.equal(await h.evaluate('app.workspace.openedLinks.length'), 0);
	// 4. frame + correct token is accepted (this is the legitimate path used by link clicks).
	await h.evaluate(`parent.postMessage({type: 'obsidian-navigate', linkText: '../sibling/sibling.html', token: ${JSON.stringify(token)}}, '*'); true`, ctx);
	await until(() => h.evaluate('app.workspace.openedLinks.length === 1'), 'authentic message handled');
	// A message from an obsolete document (after navigation) is dead: its frame/token are gone.
	await until(() => h.evaluate('view.file.path === "sibling/sibling.html"'), 'sibling loaded');
	await h.evaluate('app.workspace.openedLinks.length = 0; true');
	await h.evaluate(`window.postMessage({type: 'obsidian-navigate', linkText: '../quiz/index.html', token: ${JSON.stringify(token)}}, '*'); true`);
	await sleep(200);
	assert.equal(await h.evaluate('app.workspace.openedLinks.length'), 0);
});

test('canvas: unstyled document is opaque, light and readable over a dark host', async () => {
	await h.setViewport(390, 844);
	const ctx = await h.load(await fs.readFile('test/fixtures/sibling/sibling.html', 'utf8'));
	assert.equal(await h.evaluate('getComputedStyle(document.querySelector("h1")).color', ctx), 'rgb(0, 0, 0)');
	assert.equal(await h.evaluate('document.head.children[2].textContent', ctx), ':root{color-scheme:light}', 'light default is declared before authored CSS');
	const png = await h.screenshot('unstyled-on-dark-390');
	assert.deepEqual(png.pixel(2 * 380, 2 * 830), [255, 255, 255], 'canvas corner is white, not the dark host');
	assert.deepEqual(png.pixel(2 * 200, 2 * 400), [255, 255, 255]);
	let darkest = 255;
	for (let y = 120; y < 220; y++) for (let x = 10; x < 300; x++) darkest = Math.min(darkest, png.pixel(x * 2, y * 2)[0]);
	assert.ok(darkest < 60, `heading ink is dark (darkest ${darkest})`);
});

test('canvas: authored styling overrides defaults, including body-only backgrounds that must fill the viewport', async () => {
	await h.setViewport(390, 844);
	let ctx = await h.load('<style>html{background:#123456;color:#f0e0d0;color-scheme:dark}body{background:#102030;color:#fff}</style><h1>Authored theme</h1>');
	assert.equal(await h.evaluate('getComputedStyle(document.documentElement).backgroundColor', ctx), 'rgb(18, 52, 86)');
	assert.equal(await h.evaluate('getComputedStyle(document.body).backgroundColor', ctx), 'rgb(16, 32, 48)');
	assert.equal(await h.evaluate('getComputedStyle(document.querySelector("h1")).color', ctx), 'rgb(255, 255, 255)');
	ctx = await h.load('<style>body{background:#102030;color:#fff;margin:0}</style><h1>Body-only dark theme</h1>');
	const png = await h.screenshot('body-only-dark-390');
	assert.deepEqual(png.pixel(2 * 380, 2 * 830), [16, 32, 48], 'body background propagates to the whole canvas');
	void ctx;
});

test('quiz: local css/js/png, correct and incorrect answers via real taps, storage fallback used by script', async () => {
	const files = await quizFiles();
	const ctx = await h.load(await fs.readFile('test/fixtures/quiz/index.html', 'utf8'), files);
	assert.equal(await h.evaluate('getComputedStyle(document.body).backgroundColor', ctx), 'rgb(240, 244, 255)');
	await until(() => h.evaluate('document.querySelector("img").naturalWidth === 1', ctx), 'png decoded');
	await h.clickFrame('#btn-correct', ctx);
	assert.equal(await h.evaluate('document.querySelector("#result").textContent', ctx), 'Correct!');
	assert.equal(await h.evaluate('document.querySelector("#result").style.color', ctx), 'green');
	assert.equal(await h.evaluate('localStorage.getItem("lastAnswer")', ctx), 'correct');
	await h.clickFrame('#btn-wrong', ctx);
	assert.equal(await h.evaluate('document.querySelector("#result").textContent', ctx), 'Wrong, try again.');
	assert.equal(await h.evaluate('document.querySelector("#result").style.color', ctx), 'red');
	assert.equal(await h.evaluate('localStorage.getItem("lastAnswer")', ctx), 'wrong');
	assert.equal(await h.evaluate('document.querySelectorAll("script[src]").length', ctx), 0, 'local script is inlined, so its errors are not muted as cross-origin');
});

test('links: relative html link opens through Obsidian, title follows, parent-relative and native back return', async () => {
	const files = await quizFiles();
	let ctx = await h.load(await fs.readFile('test/fixtures/quiz/index.html', 'utf8'), files);
	await h.evaluate('app.workspace.openedLinks.length = 0; true');
	await h.clickFrame('a[href="../sibling/sibling.html"]', ctx);
	await until(() => h.evaluate('view.file.path === "sibling/sibling.html"'), 'sibling loaded');
	assert.deepEqual(await h.evaluate('app.workspace.openedLinks'), [{ linktext: 'sibling/sibling.html', sourcePath: 'quiz/index.html', newLeaf: false }]);
	assert.deepEqual(await h.evaluate('[view.getDisplayText(), document.querySelector(".view-header-title").textContent, view.getState().file]'), ['sibling', 'sibling', 'sibling/sibling.html']);
	ctx = await h.frame({ ready: (n) => h.evaluate('document.title === "Sibling Page"', n) });
	assert.equal(await h.evaluate('document.querySelector("h1").textContent', ctx), 'Sibling Page');
	await h.clickFrame('a[href="../quiz/index.html"]', ctx);
	await until(() => h.evaluate('view.file.path === "quiz/index.html"'), 'returned by relative link');
	assert.equal(await h.evaluate('document.querySelector(".view-header-title").textContent'), 'index');
	ctx = await h.frame({ ready: (n) => h.evaluate('!!document.querySelector("#btn-correct")', n) });
	await h.clickFrame('a[href="../sibling/sibling.html"]', ctx);
	await until(() => h.evaluate('view.file.path === "sibling/sibling.html"'), 'sibling again');
	await h.evaluate('app.workspace.nativeBack()');
	await until(() => h.evaluate('view.file.path === "quiz/index.html" && view.getDisplayText() === "index"'), 'native back');
	ctx = await h.frame({ ready: (n) => h.evaluate('!!document.querySelector("#btn-correct")', n) });
	await h.clickFrame('#btn-correct', ctx);
	assert.equal(await h.evaluate('document.querySelector("#result").textContent', ctx), 'Correct!');
});

test('links: anchors stay local; external URLs are shown for manual handling and never auto-open; executable schemes go nowhere', async () => {
	const files = await quizFiles();
	const html = (await fs.readFile('test/fixtures/quiz/index.html', 'utf8')).replace('</body>', '<a id="js" href="javascript:alert(1)">js</a><a id="dt" href="data:text/html,x">data</a><a id="mail" href="mailto:a@b.c">mail</a></body>');
	const ctx = await h.load(html, files);
	await h.evaluate('window.__opened = []; window.open = (...a) => { __opened.push(a); return null; }; app.workspace.openedLinks.length = 0; true');
	await h.evaluate('window.__m = 5; true', ctx);
	await h.clickFrame('a[href="#local-anchor"]', ctx);
	await until(() => h.evaluate('location.hash === "#local-anchor"', ctx), 'hash set');
	assert.equal(await h.evaluate('window.__m', ctx), 5);
	await h.clickFrame('a[href="https://example.com"]', ctx);
	await until(() => h.evaluate('notices.some(message => message.includes("https://example.com"))'), 'external URL shown for manual handling');
	assert.equal(await h.evaluate('__opened.length'), 0, 'no automatic host window opening');
	// Script-initiated clicks are not trusted and must not open anything.
	await h.evaluate('document.querySelector("a[href=\\"https://example.com\\"]").click(); document.querySelector("a[href=\\"../sibling/sibling.html\\"]").click(); true', ctx);
	for (const sel of ['#js', '#dt']) await h.clickFrame(sel, ctx);
	await sleep(250);
	assert.equal(await h.evaluate('__opened.length'), 0);
	assert.equal(await h.evaluate('app.workspace.openedLinks.length'), 0);
	assert.equal(await h.evaluate('window.__m', ctx), 5, 'still the same live document');
});

test('json: opens through the same handler and panel, never executes content, searchable', async () => {
	await h.load('<p>x</p>', { 'quiz/data.json': '{"name":"<img src=x onerror=alert(1)>","n":[1,2,{"k":"needle"}]}', 'quiz/bad.json': '{oops' });
	await h.evaluate('app.workspace.openFile("quiz/data.json")');
	const ctx = await h.frame({ ready: (n) => h.evaluate('!!document.querySelector(".json-tree")', n) });
	assert.deepEqual(await h.evaluate('[view.getViewType(), view.getDisplayText(), document.querySelector(".view-header-title").textContent]'), ['open-in-webviewer-mobile', 'data', 'data']);
	assert.equal(await h.evaluate('document.querySelectorAll("img").length', ctx), 0);
	assert.match(await h.evaluate('document.body.textContent', ctx), /<img src=x onerror=alert\(1\)>/);
	assert.equal(await h.evaluate('!!document.querySelector(".html-viewer-bar")'), true);
	await h.clickHost('button[aria-label="Search"]');
	await h.cdp('Input.insertText', { text: 'needle' });
	await until(() => h.evaluate('document.querySelector(".html-viewer-matches").textContent === "1 / 1"'), 'json search');
	await h.evaluate('app.workspace.openFile("quiz/bad.json")');
	const bad = await h.frame({ ready: (n) => h.evaluate('!!document.querySelector(".json-error")', n) });
	assert.match(await h.evaluate('document.body.textContent', bad), /Invalid JSON/);
});

test('css: conditional local @import never applies unconditionally and does not corrupt following rules', async () => {
	for (const statement of ['@import "print.css" print;', '@import url("print.css") print;', '@import "print.css" print and (min-width: 1px);']) {
		const ctx = await h.load('<link rel="stylesheet" href="main.css"><p>visible</p>', { 'quiz/main.css': statement + ' body{color:blue}', 'quiz/print.css': 'body{display:none}' });
		const display = await h.evaluate('getComputedStyle(document.body).display', ctx);
		assert.notEqual(display, 'none', statement);
		assert.equal(await h.evaluate('getComputedStyle(document.body).color', ctx), 'rgb(0, 0, 255)', statement);
	}
});

test('assets: hidden paths, traversal, non-media files and remote resources are refused with specific diagnostics', async () => {
	const files = {
		'.obsidian/secret.png': await b64('test/fixtures/quiz/icon.png'),
		'quiz/notes.md': '# private note',
		'quiz/ok.png': await b64('test/fixtures/quiz/icon.png'),
		'quiz/.hidden/x.png': await b64('test/fixtures/quiz/icon.png'),
	};
	const ctx = await h.load('<img id="a" src="../.obsidian/secret.png"><img id="b" src="notes.md"><img id="c" src="../../escape.png"><img id="d" src=".hidden/x.png"><img id="e" src="ok.png"><img id="f" src="https://tracker.invalid/p.png"><script src="https://cdn.invalid/x.js"></script>', files);
	const src = await h.evaluate('Object.fromEntries([...document.images].map(i => [i.id, i.getAttribute("src") || ""]))', ctx);
	for (const id of ['a', 'b', 'c', 'd', 'f']) assert.ok(!src[id].startsWith('data:'), `${id} must not be embedded: ${src[id].slice(0, 30)}`);
	assert.ok(src.e.startsWith('data:image/png;base64,'));
	assert.equal(await h.evaluate('document.querySelectorAll("script[src]").length', ctx), 0);
	const text = await diagnosticsText();
	for (const needle of ['.obsidian/secret.png', 'notes.md', '../../escape.png', '.hidden/x.png', 'tracker.invalid', 'cdn.invalid']) assert.ok(text.includes(needle), `diagnostics mention ${needle}`);
});

test('assets: refusals never reach the vault reader; the 10 MiB budget is spent from stat.size BEFORE reads, even for concurrent srcset', async () => {
	const png = await b64('test/fixtures/quiz/icon.png');
	const MiB = 1048576;
	const files = { 'quiz/a.png': png, 'quiz/b.png': png, 'quiz/c.png': png, 'quiz/d.png': png, '.obsidian/s.png': png, 'quiz/notes.md': '# x', 'quiz/data.json': '{}', 'quiz/huge.png': png };
	const setup = `Object.assign(app.vault.sizes, {'quiz/a.png': ${4 * MiB}, 'quiz/b.png': ${4 * MiB}, 'quiz/c.png': ${4 * MiB}, 'quiz/d.png': ${4 * MiB}, 'quiz/huge.png': ${11 * MiB}})`;
	const ctx = await h.load('<img id="h" src="../.obsidian/s.png"><img id="n" src="notes.md"><img id="j" src="data.json"><img id="a" src="a.png"><img id="b" srcset="b.png 1x, c.png 2x, d.png 3x"><img id="big" src="huge.png">', files, { setup });
	const reads = await h.evaluate('app.vault.reads.filter(p => p !== "quiz/index.html")');
	assert.deepEqual(reads, ['quiz/a.png', 'quiz/b.png'], 'only admitted files were read: hidden, non-asset, over-budget and over-size files never were');
	assert.match(await h.evaluate('document.getElementById("a").getAttribute("src")', ctx), /^data:image\/png;base64,/);
	const srcset = await h.evaluate('document.getElementById("b").getAttribute("srcset")', ctx);
	assert.match(srcset, /^data:image\/png;base64,[^ ]+ 1x$/, 'later candidates were refused, the first kept');
	const text = await diagnosticsText();
	assert.match(text, /c\.png[^\n]*budget exceeded/i);
	assert.match(text, /d\.png[^\n]*budget exceeded/i);
	assert.match(text, /huge\.png[^\n]*per-file limit/i);
	assert.match(text, /\.obsidian\/s\.png[^\n]*Hidden or configuration path/);
	assert.match(text, /notes\.md[^\n]*cannot be used/);
});

test('lifecycle: stale loads, close and unload cancel renders; no leaked message listeners', async () => {
	await h.load('<p>start</p>', { 'slow/a.html': '<p>slow</p>', 'fast/b.html': '<p>fast</p>' });
	await h.evaluate(`window.__listeners = new Set(); const add = window.addEventListener.bind(window), rem = window.removeEventListener.bind(window); window.addEventListener = (t, fn, ...r) => { if (t === 'message') __listeners.add(fn); return add(t, fn, ...r); }; window.removeEventListener = (t, fn, ...r) => { if (t === 'message') __listeners.delete(fn); return rem(t, fn, ...r); }; true`);
	// close while pending
	await h.evaluate(`app.vault.delays['slow/a.html'] = true; window.pending = view.onLoadFile(app.vault.getFileByPath('slow/a.html')); await view.onClose(); app.vault.delays['slow/a.html'](); await pending; true`);
	assert.equal(await h.evaluate('document.querySelectorAll("iframe").length'), 0);
	// newer load wins
	await h.load('<p>start</p>', { 'slow/a.html': '<p>slow</p>', 'fast/b.html': '<p>fast</p>' });
	await h.evaluate(`app.vault.delays['slow/a.html'] = true; window.pending = view.onLoadFile(app.vault.getFileByPath('slow/a.html')); await view.onLoadFile(app.vault.getFileByPath('fast/b.html')); app.vault.delays['slow/a.html'](); await pending; true`);
	assert.deepEqual(await h.evaluate('[view.file.path, view.getDisplayText()]'), ['fast/b.html', 'b']);
	const ctx = await h.frame();
	assert.equal(await h.evaluate('document.body.textContent', ctx), 'fast');
	// unload while pending
	await h.evaluate(`app.vault.delays['slow/a.html'] = true; window.pending = view.onLoadFile(app.vault.getFileByPath('slow/a.html')); await view.onUnloadFile(app.vault.getFileByPath('fast/b.html')); app.vault.delays['slow/a.html'](); await pending; true`);
	assert.equal(await h.evaluate('document.querySelectorAll("iframe").length'), 0);
	// repeated open/close does not accumulate listeners
	for (let i = 0; i < 4; i++) await h.load('<p>again</p>');
	assert.equal(await h.evaluate('__listeners.size'), 1, 'one live listener for the one open view');
	await h.evaluate('await view.onClose(); true');
	assert.equal(await h.evaluate('__listeners.size'), 0, 'message listeners released on close');
});

test('lifecycle: persisted state restores the file, live reload follows edits and stops after close', async () => {
	const files = await quizFiles();
	await h.load(await fs.readFile('test/fixtures/quiz/index.html', 'utf8'), files);
	assert.deepEqual(await h.evaluate('view.getState()'), { file: 'quiz/index.html' });
	await h.evaluate('app.workspace.requestSaveLayout(); true');
	assert.equal(await h.evaluate('app.workspace.saves.at(-1).file'), 'quiz/index.html');
	// asset edit reloads
	await h.evaluate('app.vault.modify("quiz/style.css", "body{background:rgb(1,2,3)}")');
	const ctx = await h.frame({ ready: async (n) => (await h.evaluate('getComputedStyle(document.body).backgroundColor', n)) === 'rgb(1, 2, 3)' });
	assert.ok(ctx);
	// document edit reloads
	await h.evaluate('app.vault.modify("quiz/index.html", "<h1>v2</h1>")');
	await h.frame({ ready: async (n) => (await h.evaluate('document.body.textContent', n)) === 'v2' });
	// reopen from persisted state in a fresh view
	await h.evaluate(`window.emitted = view.getState(); await view.onClose(); app.workspace.leaf = new seam.WorkspaceLeaf(app); await app.workspace.leaf.setViewState({type: 'open-in-webviewer-mobile', state: emitted}); true`);
	await h.frame({ ready: async (n) => (await h.evaluate('document.body.textContent', n)) === 'v2' });
	assert.equal(await h.evaluate('view.getDisplayText()'), 'index');
	// after close nothing reacts
	await h.evaluate('window.__reads = app.vault.reads.length; await view.onClose(); app.vault.modify("quiz/index.html", "<h1>v3</h1>"); true');
	await sleep(300);
	assert.equal(await h.evaluate('app.vault.reads.length'), await h.evaluate('window.__reads'));
});

test('no host exceptions were thrown during the renderer suite', () => {
	assert.deepEqual(h.consoleErrors, []);
});
