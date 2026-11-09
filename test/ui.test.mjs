// Compact mobile reader UI: measured in real Chromium at 390x844 and 320 wide.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHarness, until } from './browser-harness.mjs';

const fixture = fs.readFileSync('test/fixtures/cv-like/index.html', 'utf8');
const SIZES = [{ name: '390', width: 390, height: 844 }, { name: '320', width: 320, height: 640 }];
let h;
before(async () => { h = await startHarness(); });
after(async () => { await h?.stop(); });

const rect = (selector) => h.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom}; })()`);
const visible = (selector) => h.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && !e.hidden && e.getClientRects().length > 0; })()`);
async function key(k, code = k, vk = 0) {
	await h.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
	await h.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
}
const ESC = () => key('Escape', 'Escape', 27);
async function openMenu() { await h.clickHost('button[aria-label="More actions"]'); await until(() => visible('[role=menu]'), 'menu visible'); }
async function pick(action) { await h.clickHost(`[role=menuitem][data-action="${action}"]`); }

for (const size of SIZES) {
	test(`${size.name}px: one compact primary row, 44px targets, no spill, no always-visible script/width/heading controls`, async () => {
		await h.setViewport(size.width, size.height);
		const ctx = await h.load(fixture);
		await until(() => h.evaluate('window.__events.includes("tabs-wired")', ctx), 'tabs wired');
		const bar = await rect('.html-viewer-bar');
		assert.ok(bar.h <= 56, `primary row ${bar.h}px must be <= 56`);
		assert.ok(bar.h >= 44);
		assert.equal(await h.evaluate('document.querySelector(".html-viewer-bar").getAttribute("role")'), 'toolbar');
		const buttons = await h.evaluate(`[...document.querySelectorAll('.html-viewer-bar button')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return {label: b.getAttribute('aria-label'), w: r.width, h: r.height, x: r.x, r: r.right}; })`);
		assert.deepEqual(buttons.map((b) => b.label), ['Search', 'Reload', 'More actions']);
		for (const b of buttons) { assert.ok(b.w >= 44 && b.h >= 44, `${b.label} ${b.w}x${b.h} is below 44px`); assert.ok(b.x >= 0 && b.r <= size.width, `${b.label} spills`); }
		// Only the bar and the document viewport occupy layout; nothing else is a persistent row.
		const rows = await h.evaluate(`[...document.querySelector('.html-viewer-container').children].filter(e => e.getClientRects().length && getComputedStyle(e).position !== 'absolute').map(e => e.className)`);
		assert.equal(rows.length, 2, rows.join(' | '));
		assert.equal(await h.evaluate('document.querySelectorAll("input[type=checkbox], select, details").length'), 0);
		assert.equal(await h.evaluate('window.nativeActions.length'), 0, 'no duplicate native header actions on mobile');
		const frameBox = await rect('iframe');
		const content = await rect('.view-content');
		assert.ok(frameBox.h >= content.h - 56 - 1, `document keeps ${frameBox.h} of ${content.h}px`);
		assert.equal(await h.evaluate('document.documentElement.scrollWidth <= innerWidth && document.querySelector(".view-content").scrollWidth <= document.querySelector(".view-content").clientWidth'), true);
		for (const label of await h.evaluate('[...document.querySelectorAll(".html-viewer-container button")].map(b => b.getAttribute("aria-label") || b.textContent.trim())')) assert.ok(label, 'every button has an accessible name');
		await h.screenshot(`ui-closed-${size.name}`);
	});

	test(`${size.name}px: overflow menu really opens/closes (button, Escape, outside tap, choice) without stealing the viewport`, async () => {
		await h.setViewport(size.width, size.height);
		await h.load(fixture);
		const before = await rect('iframe');
		assert.equal(await visible('[role=menu]'), false, 'closed by default');
		assert.equal(await h.evaluate('document.querySelector("button[aria-label=\\"More actions\\"]").getAttribute("aria-expanded")'), 'false');
		await openMenu();
		assert.equal(await h.evaluate('document.querySelector("button[aria-label=\\"More actions\\"]").getAttribute("aria-expanded")'), 'true');
		const menu = await rect('[role=menu]');
		assert.ok(menu.x >= 0 && menu.r <= size.width && menu.b <= size.height, `menu inside viewport ${JSON.stringify(menu)}`);
		for (const item of await h.evaluate(`[...document.querySelectorAll('[role=menuitem]')].map(i => i.getBoundingClientRect().height)`)) assert.ok(item >= 44);
		assert.deepEqual(await rect('iframe'), before, 'menu overlays; the document is not resized');
		await h.screenshot(`ui-menu-${size.name}`);
		await ESC();
		await until(async () => !(await visible('[role=menu]')), 'Escape closes menu');
		assert.equal(await h.evaluate('document.activeElement && document.activeElement.getAttribute("aria-label")'), 'More actions', 'focus returns to the trigger');
		await openMenu();
		await h.clickHost('button[aria-label="More actions"]');
		await until(async () => !(await visible('[role=menu]')), 'trigger toggles menu closed');
		await openMenu();
		await h.clickAt(size.width / 2, size.height - 20); // outside tap on the scrim / document area
		await until(async () => !(await visible('[role=menu]')), 'outside tap closes menu');
		await openMenu();
		await pick('source');
		await until(async () => !(await visible('[role=menu]')) && (await h.evaluate('!!document.querySelector("pre.html-viewer-source-container")')), 'choice closes menu and shows source');
		await openMenu();
		assert.equal(await h.evaluate('document.querySelector("[data-action=source]").textContent.trim()'), 'View preview');
		await pick('source');
		await h.frame();
		assert.equal(await h.evaluate('!!document.querySelector("iframe")'), true);
	});

	test(`${size.name}px: search opens in the same row, finds, steps, and closes restoring the row`, async () => {
		await h.setViewport(size.width, size.height);
		const ctx = await h.load(fixture);
		await until(() => h.evaluate('window.__events.includes("tabs-wired")', ctx), 'tabs wired');
		const before = await rect('iframe');
		await h.clickHost('button[aria-label="Search"]');
		await until(() => h.evaluate('document.activeElement && document.activeElement.getAttribute("aria-label") === "Find in document"'), 'search input focused');
		const bar = await rect('.html-viewer-bar');
		assert.ok(bar.h <= 56, 'row stays compact while searching');
		assert.deepEqual(await rect('iframe'), before, 'search does not shrink the document');
		const controls = await h.evaluate(`[...document.querySelectorAll('.html-viewer-bar button, .html-viewer-bar input')].filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return {label: e.getAttribute('aria-label'), w: r.width, h: r.height, x: r.x, r: r.right}; })`);
		assert.deepEqual(controls.map((c) => c.label), ['Find in document', 'Previous match', 'Next match', 'Close search']);
		for (const c of controls) { assert.ok(c.h >= 44 && c.x >= 0 && c.r <= size.width, `${c.label} ${JSON.stringify(c)}`); }
		await h.cdp('Input.insertText', { text: 'convolu' });
		await until(() => h.evaluate('document.querySelector(".html-viewer-matches").textContent === "1 / 2"'), 'match counter 1 / 2');
		assert.equal(await h.evaluate('document.querySelectorAll("mark.html-viewer-match").length', ctx), 2);
		await h.clickHost('button[aria-label="Next match"]');
		await until(() => h.evaluate('document.querySelector(".html-viewer-matches").textContent === "2 / 2"'), 'next');
		await h.clickHost('button[aria-label="Previous match"]');
		await until(() => h.evaluate('document.querySelector(".html-viewer-matches").textContent === "1 / 2"'), 'previous');
		await h.screenshot(`ui-search-${size.name}`);
		await h.clickHost('button[aria-label="Close search"]');
		await until(() => h.evaluate('!!document.querySelector("button[aria-label=Search]") && document.querySelector("button[aria-label=Search]").getClientRects().length > 0'), 'primary buttons restored');
		await until(async () => (await h.evaluate('document.querySelectorAll("mark.html-viewer-match").length', ctx)) === 0, 'asynchronous iframe command clears highlights');
		assert.equal(await h.evaluate('document.querySelectorAll("mark.html-viewer-match").length', ctx), 0, 'highlights cleared');
		await h.clickHost('button[aria-label="Search"]');
		await ESC();
		await until(() => h.evaluate('document.querySelector("button[aria-label=Search]").getClientRects().length > 0'), 'Escape closes search');
	});

	test(`${size.name}px: diagnostics are closed by default, specific, dismissable, and overlay instead of resizing`, async () => {
		await h.setViewport(size.width, size.height);
		await h.load(fixture);
		assert.equal(await visible('[role=dialog]'), false);
		const before = await rect('iframe');
		await openMenu();
		const label = await h.evaluate('document.querySelector("[data-action=diagnostics]").textContent.trim()');
		assert.match(label, /^Diagnostics \([1-9]\d*\)$/);
		await pick('diagnostics');
		await until(() => visible('[role=dialog]'), 'diagnostics sheet');
		const text = await h.evaluate('document.querySelector("[role=dialog]").textContent');
		assert.match(text, /fonts\.googleapis\.com/);
		assert.match(text, /remote|blocked|offline/i);
		assert.deepEqual(await rect('iframe'), before);
		const sheet = await rect('[role=dialog]');
		assert.ok(sheet.x >= 0 && sheet.r <= size.width && sheet.b <= size.height, JSON.stringify(sheet));
		assert.equal(await h.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
		await h.screenshot(`ui-diagnostics-${size.name}`);
		await h.clickHost('[role=dialog] button[aria-label="Close"]');
		await until(async () => !(await visible('[role=dialog]')), 'sheet closes');
	});
}

test('heading jump list scrolls the document and closes', async () => {
	await h.setViewport(390, 844);
	const ctx = await h.load(fixture);
	await until(() => h.evaluate('window.__events.includes("tabs-wired")', ctx), 'tabs wired');
	await openMenu();
	await pick('headings');
	await until(() => visible('[role=dialog]'), 'headings sheet');
	const items = await h.evaluate(`[...document.querySelectorAll('[role=dialog] button[data-heading]')].map(b => ({text: b.textContent.trim(), h: b.getBoundingClientRect().height}))`);
	assert.deepEqual(items.map((i) => i.text), ['Resumen sintético', 'Capas de convolución', 'Práctica', 'Conclusión']);
	for (const i of items) assert.ok(i.h >= 44);
	await h.clickHost('[role=dialog] button[data-heading]:nth-of-type(3)');
	await until(async () => !(await visible('[role=dialog]')), 'closes after choice');
	await until(() => h.evaluate('Math.abs(document.querySelectorAll("h2")[1].getBoundingClientRect().top) < 140', ctx), 'scrolled to heading');
});

test('reload re-renders a fresh document; print is only offered when the document is ready', async () => {
	const ctx = await h.load('<p id="m">hello</p><script>window.__id = Math.random()</script>');
	const first = await h.evaluate('window.__id', ctx);
	await h.clickHost('button[aria-label="Reload"]');
	const fresh = await h.frame({ ready: async (n) => (await h.evaluate('window.__id', n)) !== first });
	assert.notEqual(await h.evaluate('window.__id', fresh), first);
	await openMenu();
	await until(() => h.evaluate('!document.querySelector("[data-action=print]").disabled'), 'print enabled after load');
});

test('Obsidian theme variables style the chrome; styles are scoped to the viewer container', async () => {
	const css = fs.readFileSync('src/vendor/style-html-viewer/styles.css', 'utf8');
	assert.match(css, /var\(--background-primary\)/);
	assert.match(css, /var\(--interactive-accent\)/);
	const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|\})\s*([^{}@]+)\{/g)].flatMap((m) => m[2].split(','));
	for (const s of selectors.map((x) => x.trim()).filter(Boolean)) assert.match(s, /html-viewer|\.workspace-leaf-content\[data-type="open-in-webviewer-mobile"\]/, `unscoped selector: ${s}`);
	assert.doesNotMatch(css, /\.(view-header|workspace-tab-header|titlebar|mod-)/);
});
