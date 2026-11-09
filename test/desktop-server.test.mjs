/**
 * Tests for desktop server security fixes.
 * Starts a real server against a temp vault directory.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";
import fs from "node:fs";

import path from "node:path";

import { startDesktopServer } from "../dist/desktop-server.js";

function fetch(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

// Set up a temp vault directory for tests
function makeTempVault() {
  fs.mkdirSync('.test-runtime', {recursive:true});
  const dir = fs.mkdtempSync(path.resolve('.test-runtime', "vault-test-"));
  // Create a normal file and a hidden directory
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello</h1>");
  fs.mkdirSync(path.join(dir, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".obsidian", "config"), '{"theme":"default"}');
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "config"), "[core]");
  // Sibling directory (outside vault)
  const sibling = path.join(path.dirname(dir), `vault-sibling-${Date.now()}`);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "secret.txt"), "secret");
  return { dir, sibling };
}

let serverHandle;
let vaultDir;
let siblingDir;

// Use beforeEach/afterEach via manual setup
const { dir, sibling } = makeTempVault();
vaultDir = dir;
siblingDir = sibling;

test("desktop server - setup", async (t) => {
  serverHandle = await startDesktopServer(vaultDir);
  assert.ok(serverHandle.port > 0, "server should have a port");
});

test("desktop server - serves normal file", async () => {
  const { status, body } = await fetch(
    `http://127.0.0.1:${serverHandle.port}/index.html`
  );
  assert.equal(status, 200);
  assert.ok(body.includes("<h1>Hello</h1>"));
});

test("desktop server - returns 404 for missing file", async () => {
  const { status } = await fetch(
    `http://127.0.0.1:${serverHandle.port}/nonexistent.html`
  );
  assert.equal(status, 404);
});

test("desktop server - blocks .obsidian directory (hidden path)", async () => {
  const { status } = await fetch(
    `http://127.0.0.1:${serverHandle.port}/.obsidian/config`
  );
  assert.equal(status, 403);
});

test("desktop server - blocks .git directory (hidden path)", async () => {
  const { status } = await fetch(
    `http://127.0.0.1:${serverHandle.port}/.git/config`
  );
  assert.equal(status, 403);
});

test("desktop server - blocks path traversal", async () => {
  // Try to escape vault via encoded ..
  const { status } = await fetch(
    `http://127.0.0.1:${serverHandle.port}/%2e%2e/%2e%2e/etc/passwd`
  );
  assert.ok(status === 403 || status === 404, `expected 403 or 404, got ${status}`);
});

test("desktop server - returns 400 on malformed percent encoding", async () => {
  const { status } = await fetch(
    `http://127.0.0.1:${serverHandle.port}/%ZZ`
  );
  assert.equal(status, 400);
});

test("desktop server - sibling prefix attack blocked (the bug fix)", async () => {
  // Try to reference the sibling directory; path normalizes outside vault
  // The sibling dir name relative to vault: '../vault-sibling-.../secret.txt'
  const siblingName = path.basename(siblingDir);
  const { status } = await fetch(
    `http://127.0.0.1:${serverHandle.port}/../${siblingName}/secret.txt`
  );
  // After path.normalize, this resolves outside the vault root → 403
  assert.ok(status === 403 || status === 404, `expected 403 or 404, got ${status}`);
});

test("desktop server - cleanup", () => {
  serverHandle.close();
  // Clean up temp dirs
  fs.rmSync(vaultDir, { recursive: true, force: true });
  fs.rmSync(siblingDir, { recursive: true, force: true });
});
