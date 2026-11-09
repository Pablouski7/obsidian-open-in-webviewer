// The storage fallback is serialized into the preview document with Function#toString,
// so it must stay self-contained even after minification. Test the minified artefact.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

let shimScript;
before(async () => {
	const result = await build({
		stdin: { contents: `import {getStorageShimScript} from './src/vendor/style-html-viewer/src/ipc/StorageShim'; globalThis.__script = getStorageShimScript('tok123');`, resolveDir: process.cwd(), loader: 'ts' },
		bundle: true, minify: true, format: 'iife', target: 'es2018', write: false, platform: 'browser',
	});
	const sandbox = { globalThis: {} };
	vm.runInNewContext(result.outputFiles[0].text, Object.assign(sandbox, { globalThis: sandbox }));
	shimScript = sandbox.__script;
});

function makeWindow({ local = 'denied', session = 'denied' } = {}) {
	const messages = [];
	const win = { parent: { postMessage: (...args) => messages.push(args) } };
	win.window = win;
	const native = () => { const m = new Map(); return { setItem: (k, v) => m.set(k, String(v)), getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k), native: true }; };
	for (const [name, mode] of [['localStorage', local], ['sessionStorage', session]]) {
		if (mode === 'ok') { const s = native(); Object.defineProperty(win, name, { configurable: true, get: () => s }); }
		else if (mode === 'denied') Object.defineProperty(win, name, { configurable: true, get() { throw new DOMException("Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.", 'SecurityError'); } });
		else if (mode === 'write-denied') { const s = native(); s.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); }; Object.defineProperty(win, name, { configurable: true, get: () => s }); }
	}
	return { win, messages, run: () => vm.runInNewContext(shimScript, vm.createContext(win)) };
}

test('shim script is self-contained after minification (no reference to bundler helpers)', () => {
	assert.match(shimScript, /^\(.*\)\("tok123"\);$/s);
	assert.doesNotMatch(shimScript, /__(name|export|toESM|commonJS|publicField)\b/);
});

test('denied localStorage/sessionStorage get a usable Storage-like fallback before any other script', () => {
	const { win, run } = makeWindow();
	assert.throws(() => win.localStorage, { name: 'SecurityError' });
	run();
	for (const name of ['localStorage', 'sessionStorage']) {
		const s = win[name];
		assert.equal(win[name], s, 'stable identity');
		assert.equal(s.getItem('missing'), null);
		s.setItem('a', 1); s.b = 'two'; s['c d'] = {};
		assert.equal(s.getItem('a'), '1');
		assert.equal(s.getItem('b'), 'two');
		assert.equal(s.getItem('c d'), '[object Object]');
		assert.equal(s.length, 3);
		assert.equal(s.key(0), 'a');
		assert.equal(s.key(3), null);
		assert.equal(s.key(-1), null);
		assert.deepEqual(Object.keys(s), ['a', 'b', 'c d']);
		assert.ok('a' in s && !('zzz' in s));
		assert.equal(Object.prototype.toString.call(s), '[object Storage]');
		s.removeItem('a'); delete s.b;
		assert.equal(s.length, 1);
		s.clear();
		assert.equal(s.length, 0);
		assert.equal(s.getItem('c d'), null);
	}
	assert.notEqual(win.localStorage, win.sessionStorage, 'separate stores');
});

test('keys that look like Storage members cannot break the API', () => {
	const { win, run } = makeWindow();
	run();
	const s = win.localStorage;
	s.setItem('getItem', 'x'); s.setItem('length', '99');
	assert.equal(typeof s.getItem, 'function');
	assert.equal(s.length, 2);
	assert.equal(s.getItem('getItem'), 'x');
	assert.equal(s.getItem('length'), '99');
});

test('working native storage is left completely alone', () => {
	const { win, run } = makeWindow({ local: 'ok', session: 'ok' });
	const nativeLocal = win.localStorage;
	run();
	assert.equal(win.localStorage, nativeLocal);
	assert.equal(win.localStorage.native, true);
	assert.equal(win.sessionStorage.native, true);
});

test('storage that reads fine but denies writes is also replaced; mixed availability is handled per store', () => {
	const { win, run } = makeWindow({ local: 'write-denied', session: 'ok' });
	run();
	win.localStorage.setItem('k', 'v');
	assert.equal(win.localStorage.getItem('k'), 'v');
	assert.equal(win.sessionStorage.native, true);
});

test('fallback is reported once per store, on first use, as in-memory (not persisted), with the render token', () => {
	const { win, messages, run } = makeWindow();
	run();
	assert.equal(messages.length, 0, 'no noise for documents that never touch storage');
	win.localStorage.getItem('x'); win.localStorage.setItem('x', '1'); win.sessionStorage.getItem('y');
	assert.equal(messages.length, 2);
	const [first] = messages[0];
	assert.equal(first.type, 'html-viewer-diagnostic');
	assert.equal(first.kind, 'notice');
	assert.equal(first.token, 'tok123');
	assert.equal(first.path, 'localStorage');
	assert.match(first.message, /in-memory/);
	assert.match(first.message, /not saved/);
	assert.equal(messages[0][1], '*');
	assert.equal(messages[1][0].path, 'sessionStorage');
});

test('running twice does not double-wrap', () => {
	const { win, run } = makeWindow();
	run();
	win.localStorage.setItem('k', 'v');
	run();
	assert.equal(win.localStorage.getItem('k'), 'v');
});

test('a window whose property cannot be redefined fails closed with a diagnostic instead of throwing', () => {
	const { win, messages, run } = makeWindow();
	Object.defineProperty(win, 'localStorage', { configurable: false, get() { throw new DOMException('denied', 'SecurityError'); } });
	assert.doesNotThrow(run);
	assert.ok(messages.some(([m]) => /could not install/i.test(m.message) && m.path === 'localStorage'));
	assert.equal(win.sessionStorage.getItem('still'), null, 'the other store is still repaired');
});
