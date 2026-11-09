/**
 * JSON safe-rendering for the mobile view.
 * Parses JSON and returns an HTML tree; never executes the JSON as code.
 */

export function renderJsonSafe(jsonText: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (e) {
		const escaped = escapeHtml(jsonText);
		return `<div class="json-error">Invalid JSON: ${escapeHtml(String(e))}</div><pre><code>${escaped}</code></pre>`;
	}
	return `<div class="json-tree">${renderValue(parsed, 0)}</div>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function renderValue(val: unknown, depth: number): string {
	if (val === null) return `<span class="json-null">null</span>`;
	if (typeof val === "boolean")
		return `<span class="json-bool">${val}</span>`;
	if (typeof val === "number")
		return `<span class="json-num">${escapeHtml(String(val))}</span>`;
	if (typeof val === "string")
		return `<span class="json-str">${escapeHtml(JSON.stringify(val))}</span>`;
	if (Array.isArray(val)) {
		if (val.length === 0) return `<span class="json-bracket">[]</span>`;
		const items = val
			.map((v) => `<li>${renderValue(v, depth + 1)}</li>`)
			.join("");
		return `<details open><summary class="json-bracket">[${val.length}]</summary><ol>${items}</ol></details>`;
	}
	if (typeof val === "object") {
		const obj = val as Record<string, unknown>;
		const keys = Object.keys(obj);
		if (keys.length === 0) return `<span class="json-bracket">{}</span>`;
		const items = keys
			.map(
				(k) =>
					`<li><span class="json-key">${escapeHtml(JSON.stringify(k))}</span>: ${renderValue(obj[k], depth + 1)}</li>`
			)
			.join("");
		return `<details open><summary class="json-bracket">{${keys.length}}</summary><ul>${items}</ul></details>`;
	}
	return escapeHtml(String(val));
}

export const JSON_STYLES = `
.json-tree{font-family:monospace;font-size:0.9em;padding:1em;}
.json-null{color:#888;}
.json-bool{color:#0a7;}
.json-num{color:#07a;}
.json-str{color:#a70;}
.json-key{color:#70a;}
.json-bracket{color:#555;cursor:pointer;}
.json-error{color:#c00;font-weight:bold;}
details>ol,details>ul{margin:0 0 0 1.5em;padding:0;list-style:none;}
`;

/**
 * Wraps rendered JSON in a standalone page. The viewer's resolver adds the CSP, the bridge script and the
 * light canvas to it exactly as for HTML documents, so search and heading jump behave the same.
 */
export function buildJsonPage(jsonText: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>${JSON_STYLES}</style></head><body>${renderJsonSafe(jsonText)}</body></html>`;
}
