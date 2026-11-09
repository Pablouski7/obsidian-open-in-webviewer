/**
 * Shared path-security helpers used by both the desktop server and the mobile
 * asset resolver.  Pure functions; no Node or Obsidian runtime dependencies.
 */

/** Hidden path segments that must never be served. */
const HIDDEN_PATTERNS = [
	/(?:^|\/)\.obsidian(?:\/|$)/,
	/(?:^|\/)\.git(?:\/|$)/,
	/(?:^|\/)\.env(?:\/|$)/,
];

/**
 * Returns true when the normalised vault-relative path contains a hidden
 * segment (starts with a dot, e.g. `.obsidian`, `.git`, `.env`).
 */
export function isHiddenPath(vaultRelative: string): boolean {
	const normalised = vaultRelative.replace(/\\/g, "/");
	// Any path segment that begins with a dot is hidden.
	return normalised.split("/").some((segment) => segment.startsWith("."));
}

/**
 * Returns true if `child` is strictly inside `root` after normalisation.
 * Uses separator-aware prefix matching to prevent the classic
 * "/vault" vs "/vault-sibling" traversal bug.
 */
export function isInsideRoot(root: string, child: string): boolean {
	// Normalise separators to forward slash for comparison.
	const r = root.replace(/\\/g, "/").replace(/\/$/, "");
	const c = child.replace(/\\/g, "/");
	return c === r || c.startsWith(r + "/");
}

/**
 * Strips the query string and URL fragment from a raw URL/path string, then
 * percent-decodes it.  Returns `null` on malformed input (e.g. lone `%`).
 */
export function decodePathSafe(raw: string): string | null {
	try {
		const withoutQuery = raw.split("?")[0].split("#")[0];
		return decodeURIComponent(withoutQuery);
	} catch {
		return null;
	}
}

/**
 * Schemes that are never allowed as navigation targets from iframe messages.
 */
const FORBIDDEN_SCHEMES = /^(javascript|data|vbscript|about|blob):/i;

export function isForbiddenScheme(url: string): boolean {
	return FORBIDDEN_SCHEMES.test(url.trim());
}

/**
 * Returns true when the URL is an external (non-vault) HTTP/HTTPS link.
 */
export function isExternalUrl(url: string): boolean {
	return /^https?:\/\//i.test(url.trim());
}
