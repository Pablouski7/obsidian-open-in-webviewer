/**
 * Tests for src/security.ts
 * Run with: node --experimental-vm-modules test/security.test.mjs
 * (or via npm test)
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

// We import the compiled JS from the TypeScript source.
// Tests run after `tsc` compiles to dist/.
import {
  isHiddenPath,
  isInsideRoot,
  decodePathSafe,
  isForbiddenScheme,
  isExternalUrl,
} from "../dist/security.js";

test("isHiddenPath - detects .obsidian", () => {
  assert.equal(isHiddenPath(".obsidian/plugins"), true);
  assert.equal(isHiddenPath("notes/.obsidian/config"), true);
  assert.equal(isHiddenPath(".git/config"), true);
  assert.equal(isHiddenPath(".env"), true);
  assert.equal(isHiddenPath("notes/.hidden"), true);
});

test("isHiddenPath - allows normal paths", () => {
  assert.equal(isHiddenPath("notes/index.html"), false);
  assert.equal(isHiddenPath("quiz/style.css"), false);
  assert.equal(isHiddenPath(""), false);
});

test("isInsideRoot - basic containment", () => {
  assert.equal(isInsideRoot("/vault", "/vault/notes/file.html"), true);
  assert.equal(isInsideRoot("/vault", "/vault"), true);
});

test("isInsideRoot - sibling prefix attack (the bug)", () => {
  // /vault-sibling must NOT be considered inside /vault
  assert.equal(isInsideRoot("/vault", "/vault-sibling/evil.html"), false);
  assert.equal(isInsideRoot("/vault", "/vaultother"), false);
});

test("isInsideRoot - traversal attack (normalized paths)", () => {
  // isInsideRoot expects already-normalized paths (the server calls path.normalize first).
  // After normalization, /vault/../etc/passwd becomes /etc/passwd.
  assert.equal(isInsideRoot("/vault", "/etc/passwd"), false);
  assert.equal(isInsideRoot("/vault", "/"), false);
  assert.equal(isInsideRoot("/vault", "/vault2"), false);
});

test("decodePathSafe - normal paths", () => {
  assert.equal(decodePathSafe("/notes/file.html"), "/notes/file.html");
  assert.equal(decodePathSafe("/notes/caf%C3%A9.html"), "/notes/café.html");
  assert.equal(decodePathSafe("/path%20with%20spaces/f.html"), "/path with spaces/f.html");
});

test("decodePathSafe - strips query and fragment", () => {
  assert.equal(decodePathSafe("/file.html?v=1"), "/file.html");
  assert.equal(decodePathSafe("/file.html#section"), "/file.html");
  assert.equal(decodePathSafe("/file.html?v=1#s"), "/file.html");
});

test("decodePathSafe - returns null on malformed percent", () => {
  assert.equal(decodePathSafe("/%ZZ"), null);
  assert.equal(decodePathSafe("/%"), null);
});

test("isForbiddenScheme", () => {
  assert.equal(isForbiddenScheme("javascript:alert(1)"), true);
  assert.equal(isForbiddenScheme("data:text/html,<h1>hi</h1>"), true);
  assert.equal(isForbiddenScheme("vbscript:msgbox"), true);
  assert.equal(isForbiddenScheme("https://example.com"), false);
  assert.equal(isForbiddenScheme("../relative.html"), false);
});

test("isExternalUrl", () => {
  assert.equal(isExternalUrl("https://example.com"), true);
  assert.equal(isExternalUrl("http://evil.com"), true);
  assert.equal(isExternalUrl("../relative.html"), false);
  assert.equal(isExternalUrl("javascript:void(0)"), false);
});
