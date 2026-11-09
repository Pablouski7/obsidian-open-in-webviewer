/**
 * Tests for src/json-renderer.ts
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { renderJsonSafe } from "../dist/json-renderer.js";

test("renderJsonSafe - renders a simple object", () => {
  const out = renderJsonSafe('{"name":"Alice","age":30}');
  // Keys and string values are HTML-escaped (quotes become &quot;)
  assert.ok(out.includes("&quot;name&quot;"), "should include escaped key");
  assert.ok(out.includes("&quot;Alice&quot;"), "should include escaped string value");
  assert.ok(out.includes("30"), "should include number value");
});

test("renderJsonSafe - renders a simple array", () => {
  const out = renderJsonSafe('[1,2,3]');
  assert.ok(out.includes("1"));
  assert.ok(out.includes("3"));
});

test("renderJsonSafe - handles null, boolean, number", () => {
  const out = renderJsonSafe('{"a":null,"b":true,"c":false,"d":42}');
  assert.ok(out.includes("null"));
  assert.ok(out.includes("true"));
  assert.ok(out.includes("false"));
  assert.ok(out.includes("42"));
});

test("renderJsonSafe - escapes HTML in keys and values", () => {
  const out = renderJsonSafe('{"<script>":"alert(1)"}');
  assert.ok(!out.includes("<script>"), "raw <script> must not appear");
  assert.ok(out.includes("&lt;script&gt;"), "must be HTML-escaped");
  // The value "alert(1)" is wrapped in JSON string quotes which are also HTML-escaped
  assert.ok(out.includes("alert(1)"), "value content should appear (safely escaped in JSON quotes)");
});

test("renderJsonSafe - handles invalid JSON gracefully", () => {
  const out = renderJsonSafe("not valid json {{{");
  assert.ok(out.includes("json-error") || out.includes("Invalid JSON"), "should report invalid JSON");
  // Must NOT throw
});

test("renderJsonSafe - nested object renders without executing content", () => {
  const payload = JSON.stringify({ exec: "<img onerror='alert(1)' src=x>" });
  const out = renderJsonSafe(payload);
  // The dangerous HTML is inside a JSON string value which is fully HTML-escaped.
  // The < > are escaped, so <img ...> can't be an HTML tag.
  assert.ok(!out.includes("<img"), "raw <img> tag must not appear unescaped");
  assert.ok(out.includes("&lt;img"), "img must appear HTML-escaped");
});

test("renderJsonSafe - empty object", () => {
  const out = renderJsonSafe("{}");
  assert.ok(out.includes("{"));
});

test("renderJsonSafe - empty array", () => {
  const out = renderJsonSafe("[]");
  assert.ok(out.includes("["));
});
