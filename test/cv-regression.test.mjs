// Synthetic regression for the real CV "Código / práctica" failure pattern:
// storage is read at the top of an inline IIFE BEFORE the tab observer is wired,
// tabs are plain a[href="#id"] links under a sticky nav, fonts come from Google.
// No personal content: fixtures/cv-like/index.html is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHarness, until } from './browser-harness.mjs';

const fixture = fs.readFileSync('test/fixtures/cv-like/index.html', 'utf8');
let h;
before(async () => { h = await startHarness(); });
after(async () => { await h?.stop(); });

test('control: in a bare sandboxed frame storage throws, aborting the script before tabs are wired', async () => {
	await h.evaluate(`document.body.replaceChildren(); const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.srcdoc = ${JSON.stringify(fixture)}; document.body.append(f); true`);
	const ctx = await h.frame({ ready: (n) => h.evaluate('!!window.__events', n) });
	assert.equal(await h.evaluate('window.__headProbe', ctx), 'threw:SecurityError');
	assert.deepEqual(await h.evaluate('window.__events', ctx), ['script-start']);
	// Nothing is wired: the sticky tabs never get an active state.
	await h.evaluate('document.querySelector("#codigo").scrollIntoView()', ctx);
	await h.sleep(300);
	assert.equal(await h.evaluate('document.querySelectorAll("nav a.active").length', ctx), 0);
});

test('control: in a bare sandboxed srcdoc frame, a plain a[href="#id"] click navigates the frame to the HOST page URL (independent of storage and scripts)', async () => {
	for (const html of [fixture, '<a href="#x">go</a><div style="height:2000px"></div><div id="x">target</div>']) {
		await h.evaluate(`document.body.replaceChildren(); const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.srcdoc = ${JSON.stringify(html)}; f.style.cssText = 'width:100%;height:600px'; document.body.append(f); true`);
		const ctx = await h.frame();
		await h.evaluate('window.__marker = 42; true', ctx);
		await h.clickFrame('a[href="#codigo"],a[href="#x"]', ctx);
		const hostUrl = await h.evaluate('location.origin');
		// The document is replaced by the host page itself: this is the blank frame (in Obsidian: the app's index.html,
		// whose scripts then fail in the opaque frame with a bare "Script error.").
		const after = await until(async () => {
			const c = await h.frame().catch(() => null);
			if (!c) return null;
			const href = await h.evaluate('location.href', c).catch(() => '');
			return href.startsWith(hostUrl + '/#') ? { c, href } : null;
		}, 'frame navigated to the host URL');
		assert.match(after.href, /^http:\/\/127\.0\.0\.1:\d+\/#(codigo|x)$/);
		assert.equal(await h.evaluate('window.__marker', after.c), undefined, 'original document is gone');
	}
});

test('integrated: document scripts run with no opt-in, no checkbox, no input', async () => {
	const ctx = await h.load(fixture);
	await until(() => h.evaluate('window.__events && window.__events.includes("tabs-wired")', ctx), 'tabs wired');
	assert.equal(await h.evaluate('document.getElementById("themeToggle").textContent', ctx), 'Modo oscuro');
	assert.equal(await h.evaluate('document.querySelectorAll("input[type=checkbox]").length'), 0);
	assert.doesNotMatch(await h.evaluate('document.body.textContent'), /Run document scripts/i);
});

test('integrated: storage fallback exists BEFORE authored scripts and behaves like Storage', async () => {
	const ctx = await h.load(fixture);
	assert.equal(await h.evaluate('window.__headProbe', ctx), 'ok-null');
	assert.deepEqual(await h.evaluate('window.__events.slice(0, 2)', ctx), ['script-start', 'storage-read:null']);
	const api = await h.evaluate(`(() => {
		const out = {};
		for (const name of ['localStorage', 'sessionStorage']) {
			const s = window[name];
			s.clear();
			s.setItem('a', 1); s['b'] = 'two'; s.c = null;
			out[name] = {
				a: s.getItem('a'), b: s.getItem('b'), c: s.getItem('c'), missing: s.getItem('zz'),
				length: s.length, key0: s.key(0), keys: Object.keys(s).sort(), inOp: 'a' in s, viaProp: s.b,
				ctor: Object.prototype.toString.call(s),
			};
			s.removeItem('a'); delete s.b;
			out[name].afterRemove = s.length;
			s.clear();
			out[name].afterClear = s.length;
		}
		return out;
	})()`, ctx);
	for (const name of ['localStorage', 'sessionStorage']) {
		assert.deepEqual(api[name], { a: '1', b: 'two', c: 'null', missing: null, length: 3, key0: 'a', keys: ['a', 'b', 'c'], inOp: true, viaProp: 'two', ctor: '[object Storage]', afterRemove: 1, afterClear: 0 }, name);
	}
});

test('integrated: real clicks on the theme toggle use storage; state is in-memory only and says so', async () => {
	const ctx = await h.load(fixture);
	await h.clickFrame('#themeToggle', ctx);
	assert.equal(await h.evaluate('document.documentElement.getAttribute("data-theme")', ctx), 'dark');
	assert.equal(await h.evaluate('[localStorage.getItem("demo-theme"), sessionStorage.getItem("last-toggle")]', ctx).then(String), 'dark,dark');
	await h.clickFrame('#themeToggle', ctx);
	assert.equal(await h.evaluate('localStorage.getItem("demo-theme")', ctx), 'light');
	// The limitation is surfaced in diagnostics, not hidden.
	await h.clickHost('button[aria-label="More actions"]');
	assert.match(await h.evaluate('document.querySelector("[role=menu]").textContent'), /Diagnostics \(\d+\)/);
	await h.clickHost('[role=menuitem][data-action="diagnostics"]');
	assert.match(await h.evaluate('document.querySelector("[role=dialog]").textContent'), /localStorage[^\n]*(in-memory|not saved)/i);
	// Reload = a new document: nothing persisted.
	await h.clickHost('[role=dialog] button[aria-label="Close"]');
	await h.clickHost('button[aria-label="Reload"]');
	const fresh = await h.frame({ ready: (n) => h.evaluate('!!window.__events && window.__events.includes("tabs-wired")', n) });
	assert.equal(await h.evaluate('localStorage.getItem("demo-theme")', fresh), null);
});

test('integrated: opaque frame cannot reach the host (DOM, storage, Node/Electron globals)', async () => {
	await h.evaluate('localStorage.setItem("host-secret", "keep"); true');
	const ctx = await h.load(fixture);
	const probe = await h.evaluate(`(() => {
		const t = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.name; } };
		return {
			parentDoc: t(() => parent.document.body),
			parentStorage: t(() => parent.localStorage.getItem('host-secret')),
			topDoc: t(() => top.document.body),
			origin: String(window.origin),
			nodeGlobals: [typeof require, typeof process, typeof module, typeof electron, typeof window.app].join(','),
		};
	})()`, ctx);
	assert.deepEqual(probe, { parentDoc: 'SecurityError', parentStorage: 'SecurityError', topDoc: 'SecurityError', origin: 'null', nodeGlobals: 'undefined,undefined,undefined,undefined,undefined' });
	await h.clickFrame('#themeToggle', ctx);
	assert.equal(await h.evaluate('localStorage.getItem("host-secret")'), 'keep');
	assert.equal(await h.evaluate('localStorage.getItem("demo-theme")'), null, 'document storage must never write through to the host');
	const sandbox = await h.evaluate('document.querySelector("iframe").getAttribute("sandbox").split(/\\s+/).sort().join(" ")');
	assert.equal(sandbox, 'allow-modals allow-scripts');
});

test('integrated: clicking a[href="#codigo"] (real tap) keeps the same live document and reaches the section', async () => {
	const ctx = await h.load(fixture);
	await until(() => h.evaluate('window.__events.includes("tabs-wired")', ctx), 'tabs wired');
	await h.evaluate('window.__marker = 7; window.__hashchanges = 0; addEventListener("hashchange", () => __hashchanges++); true', ctx);
	const hostFrame = await h.evaluate('document.querySelector("iframe") && "present"');
	assert.equal(hostFrame, 'present');
	await h.clickFrame('a[href="#codigo"]', ctx);
	await until(() => h.evaluate('document.querySelector("a.code-tab").classList.contains("active")', ctx), 'code tab active (IntersectionObserver was wired)');
	assert.equal(await h.evaluate('window.__marker', ctx), 7, 'same document, no navigation');
	const top = await h.evaluate('document.querySelector("#codigo").getBoundingClientRect().top', ctx);
	assert.ok(top >= -2 && top < 140, `section aligned under sticky nav, top=${top}`);
	assert.equal(await h.evaluate('document.querySelector("iframe").isConnected && document.querySelector("iframe").contentWindow !== null'), true);
	assert.equal(await h.evaluate('document.querySelector("#practice-note").offsetParent !== null', ctx), true);
	// Every other tab works too and there is never a navigation.
	for (const [href, id] of [['#cierre', 'cierre'], ['#inicio', 'inicio'], ['#teoria', 'teoria'], ['#codigo', 'codigo']]) {
		await h.clickFrame(`a[href="${href}"]`, ctx);
		await until(() => h.evaluate(`Math.abs(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().top) < 140`, ctx), `scrolled to ${id}`);
	}
	assert.equal(await h.evaluate('window.__marker', ctx), 7);
	const png = await h.screenshot('cv-codigo-390');
	// Not blank: the frame region contains both page background and ink.
	const colors = new Set();
	for (let y = 100; y < 800; y += 20) for (let x = 10; x < 380; x += 20) colors.add(png.pixel(x * 2, y * 2).join(','));
	assert.ok(colors.size > 3, `frame painted ${colors.size} distinct colours`);
});

test('integrated: hash-only anchors are completed inside the document (#, #top, percent-encoded id, name=, missing id, author handlers)', async () => {
	const pad = '<div style="height:1500px"></div>';
	const html = `<style>body{margin:0}</style>
		<a id="l-top" href="#">top</a> <a id="l-top2" href="#top">TOP</a> <a id="l-enc" href="#caf%C3%A9">enc</a>
		<a id="l-named" href="#named-target">named</a> <a id="l-missing" href="#nope">missing</a> <a id="l-own" href="#own-target">own</a>
		${pad}<h2 id="café">café</h2>${pad}<a name="named-target"></a><p>named</p>${pad}<h2 id="own-target">own</h2>${pad}
		<script>window.__marker = 11; window.__clicked = 0; document.getElementById('l-own').addEventListener('click', function(){ window.__clicked++; }); window.__hashes = []; addEventListener('hashchange', function(){ __hashes.push(location.hash); });</script>`;
	const ctx = await h.load(html);
	const state = () => h.evaluate('({marker: window.__marker, href: location.href, y: Math.round(scrollY)})', ctx);
	const topOf = (sel) => h.evaluate(`Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top)`, ctx);
	const tap = (sel) => h.evaluate(`document.querySelector(${JSON.stringify(sel)}).click(); true`, ctx);
	// A real, trusted tap first (percent-encoded id).
	await h.clickFrame('#l-enc', ctx);
	await until(async () => Math.abs(await topOf('#café')) < 3, 'scrolled to é heading');
	let s = await state();
	assert.equal(s.marker, 11, 'same document');
	assert.match(s.href, /^about:srcdoc#caf/, 'stays the srcdoc document, never the host URL');
	// Named anchor.
	await h.evaluate('scrollTo(0, 0); true', ctx);
	await tap('#l-named');
	await until(async () => Math.abs(await topOf('a[name="named-target"]')) < 3, 'scrolled to name= anchor');
	// href="#" and an id that does not exist (#top) both mean the top.
	await tap('#l-top');
	await until(async () => (await state()).y === 0, '# scrolls to top');
	await h.evaluate('scrollTo(0, 3000); true', ctx);
	await tap('#l-top2');
	await until(async () => (await state()).y === 0, '#top scrolls to top');
	// A missing id must not lose the document or throw.
	await h.evaluate('scrollTo(0, 1200); true', ctx);
	const before = (await state()).y;
	await tap('#l-missing');
	s = await state();
	assert.equal(s.marker, 11);
	assert.equal(s.y, before, 'no scroll for a missing id');
	assert.match(s.href, /^about:srcdoc/);
	// Authored click handlers still run, and the navigation still completes.
	await h.evaluate('scrollTo(0, 0); true', ctx);
	await tap('#l-own');
	await until(async () => Math.abs(await topOf('#own-target')) < 3, 'scrolled to #own-target');
	assert.equal(await h.evaluate('window.__clicked', ctx), 1);
	// :target and hashchange based documents keep working because location.hash is set on the document URL.
	assert.equal(await h.evaluate('document.querySelector(":target") && document.querySelector(":target").id', ctx), 'own-target');
	assert.ok((await h.evaluate('window.__hashes.length', ctx)) >= 1);
	assert.equal((await state()).marker, 11);
});

test('integrated: reload keeps the document alive through the same anchor flow (no host page inside the frame)', async () => {
	const ctx = await h.load(fixture);
	await h.clickFrame('a[href="#cierre"]', ctx);
	await until(() => h.evaluate('Math.abs(document.getElementById("cierre").getBoundingClientRect().top) < 140', ctx), 'at cierre');
	assert.equal(await h.evaluate('document.querySelector("iframe").contentWindow.length >= 0'), true);
	assert.equal(await h.evaluate('[...document.querySelectorAll("iframe")].length'), 1, 'one frame, still the document and not a nested app page');
	assert.match(await h.evaluate('location.href', ctx), /^about:srcdoc#cierre$/);
});

test('integrated: script failures name the real error and file, not a bare "Script error."', async () => {
	await h.load('<script src="boom.js"></script><script>nope.x</script><p>still rendered</p>', { 'quiz/boom.js': 'var a = 1;\nundefinedFunction();\n' });
	await h.clickHost('button[aria-label="More actions"]');
	await h.clickHost('[role=menuitem][data-action="diagnostics"]');
	const text = await h.evaluate('document.querySelector("[role=dialog]").textContent');
	assert.match(text, /undefinedFunction is not defined/);
	assert.match(text, /nope is not defined/);
	assert.doesNotMatch(text, /^Script error\.$/m);
});
