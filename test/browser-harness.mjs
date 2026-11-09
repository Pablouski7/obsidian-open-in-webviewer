// Shared real-browser harness. Launches Chromium WITH its sandbox (no --no-sandbox),
// bundles the real plugin entry (main.ts) against the Obsidian seam, and drives it
// over the DevTools protocol, including real (trusted) mouse input and screenshots.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { browserTestBuildOptions } from '../esbuild.shared.mjs';

export const runtimeRoot = path.resolve('.test-runtime');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, label = 'condition', tries = 200) {
	for (let i = 0; i < tries; i++) {
		const v = await fn();
		if (v) return v;
		await sleep(30);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) for pixel assertions. */
export function decodePng(buf) {
	let offset = 8, width = 0, height = 0, colorType = 0;
	const idat = [];
	while (offset < buf.length) {
		const len = buf.readUInt32BE(offset);
		const type = buf.toString('ascii', offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + len);
		if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
		else if (type === 'IDAT') idat.push(data);
		offset += 12 + len;
	}
	const bpp = colorType === 6 ? 4 : 3;
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * bpp;
	const out = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		for (let x = 0; x < stride; x++) {
			const left = x >= bpp ? out[y * stride + x - bpp] : 0;
			const up = y ? out[(y - 1) * stride + x] : 0;
			const upLeft = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
			const value = raw[y * (stride + 1) + 1 + x];
			let result;
			if (filter === 0) result = value;
			else if (filter === 1) result = value + left;
			else if (filter === 2) result = value + up;
			else if (filter === 3) result = value + ((left + up) >> 1);
			else {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
				result = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
			}
			out[y * stride + x] = result & 255;
		}
	}
	return { width, height, pixel: (x, y) => [...out.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}

export async function startHarness({ width = 390, height = 844 } = {}) {
	await fs.mkdir(runtimeRoot, { recursive: true });
	const hostJs = path.join(runtimeRoot, `host-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
	await build(browserTestBuildOptions({
		stdin: {
			contents: `import Main from './main'; import * as seam from './test/renderer-seam'; window.seam = seam; window.Main = Main;`,
			resolveDir: process.cwd(),
		},
		outfile: hostJs,
		alias: { obsidian: path.resolve('test/renderer-seam.ts') },
	}));
	const js = await fs.readFile(hostJs);
	const css = await fs.readFile('src/vendor/style-html-viewer/styles.css', 'utf8');
	const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:dark;--background-primary:#1e1e1e;--background-primary-alt:#262626;--background-secondary:#262626;--background-modifier-border:#3f3f3f;--background-modifier-hover:rgba(255,255,255,.08);--text-normal:#dadada;--text-muted:#a6a6a6;--text-faint:#666;--text-error:#fb464c;--text-warning:#e0ac00;--text-on-accent:#fff;--interactive-accent:#7b6cd9;--interactive-normal:#2b2b2b;--interactive-hover:#363636;--font-ui-small:13px;--font-ui-medium:15px;--font-monospace:ui-monospace,monospace;--size-4-2:8px;--radius-m:8px}
html,body{margin:0;height:100%;background:#1e1e1e;color:#dadada;font:16px system-ui,sans-serif}
body{display:flex;flex-direction:column}
.workspace-leaf-content{display:flex;flex-direction:column;height:100%;min-height:0}
.view-header{flex:0 0 44px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #3f3f3f;box-sizing:border-box}
.view-content{flex:1 1 auto;min-height:0;position:relative;overflow:hidden}
</style><style id="plugin-css">${css}</style></head><body>
<script src="/host.js"></script></body></html>`;
	const server = http.createServer((req, res) => {
		if (req.url === '/host.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
		res.setHeader('Content-Type', 'text/html'); res.end(page);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));

	const profile = await fs.mkdtemp(path.join(runtimeRoot, 'profile-'));
	const executable = process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM || '/usr/sbin/chromium';
	const browser = spawn(executable, [
		'--headless', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
		// Keeps sandboxed (opaque-origin) frames in the CDP page session. The OS sandbox stays enabled.
		'--disable-site-isolation-trials',
		'--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	browser.stderr.on('data', (d) => { stderr += d; });
	const endpoint = await until(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1], 'DevTools endpoint');
	const port = new URL(endpoint).port;
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const socket = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
	await new Promise((r) => socket.addEventListener('open', r, { once: true }));

	let id = 0;
	const calls = new Map();
	const contexts = new Map();
	const consoleErrors = [];
	socket.addEventListener('message', (e) => {
		const m = JSON.parse(e.data);
		if (m.id) {
			const p = calls.get(m.id);
			calls.delete(m.id);
			m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
		}
		if (m.method === 'Runtime.executionContextCreated') contexts.set(m.params.context.id, m.params.context);
		if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(m.params.executionContextId);
		if (m.method === 'Runtime.executionContextsCleared') contexts.clear();
		if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
	});
	const cdp = (method, params = {}) => {
		const n = ++id;
		const p = new Promise((resolve, reject) => calls.set(n, { resolve, reject }));
		socket.send(JSON.stringify({ id: n, method, params }));
		return p;
	};
	async function evaluate(expression, contextId) {
		const r = await cdp('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true, replMode: true });
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
		// CDP omits `value` for IEEE-754 -0/NaN/infinities, even with returnByValue.
		// Geometry rounded just above the viewport can be -0, not undefined.
		const special = r.result.unserializableValue;
		if (['-0', 'NaN', 'Infinity', '-Infinity'].includes(special)) return Number(special);
		if (typeof special === 'string' && /^-?\d+n$/.test(special)) return BigInt(special.slice(0, -1));
		return r.result.value;
	}
	/** Execution context of the (single) child frame, once it has a body. */
	async function frame({ ready = (n) => evaluate('document.readyState === "complete" && !!document.body && document.body.childNodes.length > 0', n) } = {}) {
		return until(async () => {
			const tree = await cdp('Page.getFrameTree');
			const frameId = tree.frameTree.childFrames?.[0]?.frame.id;
			for (const [n, c] of contexts) {
				if (c.auxData?.isDefault && c.auxData.frameId === frameId) {
					try { if (await ready(n)) return n; } catch { /* context is being replaced */ }
				}
			}
		}, 'iframe execution context');
	}
	async function setViewport(w, h) {
		await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
	}
	await cdp('Runtime.enable');
	await cdp('Page.enable');
	await setViewport(width, height);
	await cdp('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
	await until(() => evaluate('!!window.Main'), 'host bundle');
	await evaluate(`window.notices = []; window.boot = async () => { window.app = new seam.App(); window.plugin = new Main(app, {}); await plugin.onload(); return plugin; }; true`);

	const harness = {
		cdp, evaluate, frame, until, sleep, setViewport, consoleErrors,
		/** Boots the real plugin entry and opens quiz/index.html through the registered extension handler. */
		async load(html, extra = {}, { reboot = true, setup = '' } = {}) {
			await evaluate(`(async () => {
				if (window.view) await window.view.onClose().catch(() => {});
				document.body.replaceChildren();
				window.notices = []; window.nativeActions = [];
				if (${reboot} || !window.app) await boot();
				window.app.workspace.leaf = new seam.WorkspaceLeaf(window.app);
				window.app.workspace.navStack = [];
				Object.assign(window.app.vault.files, ${JSON.stringify({ 'quiz/index.html': html, ...extra })});
				${setup};
				await window.app.workspace.openFile('quiz/index.html');
			})()`);
			return frame();
		},
		async screenshot(name) {
			const { data } = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true });
			const buffer = Buffer.from(data, 'base64');
			const dir = path.join(runtimeRoot, 'screenshots');
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, `${name}.png`), buffer);
			return decodePng(buffer);
		},
		/** Real trusted click at host-page coordinates. */
		async clickAt(x, y) {
			await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
			await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
			await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
		},
		async clickHost(selector) {
			const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'nearest'}); const b = e.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; })()`);
			if (!r) throw new Error('No host element ' + selector);
			await harness.clickAt(r.x, r.y);
		},
		async clickFrame(selector, ctx) {
			const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; })()`, ctx);
			if (!r) throw new Error('No frame element ' + selector);
			const f = await evaluate(`(() => { const b = document.querySelector('iframe').getBoundingClientRect(); return {x: b.x, y: b.y}; })()`);
			await harness.clickAt(f.x + r.x, f.y + r.y);
		},
		async stop() {
			socket.close();
			browser.kill();
			await new Promise((r) => (browser.exitCode !== null ? r() : browser.once('exit', r)));
			await new Promise((r) => server.close(r));
			await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
			await fs.rm(hostJs, { force: true }).catch(() => {});
		},
	};
	return harness;
}
