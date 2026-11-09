/**
 * Desktop HTTP server with security fixes:
 *
 * FIX 1 — Traversal: use separator-aware path containment check
 *   (the original `startsWith` was vulnerable to sibling-prefix attacks like
 *   `/vault` matching `/vault-sibling`).
 *
 * FIX 2 — Malformed URL crash: `decodeURIComponent` throws on invalid percent
 *   sequences; wrap with try/catch and return 400.
 *
 * FIX 3 — Hidden path blocking: .obsidian, .git, .env etc. are always 403.
 *
 * FIX 4 — Symlink escape: `fs.realpath` resolves symlinks before the
 *   containment check (defence-in-depth; vault root itself is also resolved).
 *
 * Uses lazy require() so this module can be imported without crashing on
 * mobile (where `http`, `fs`, `path` are not available).  The start()
 * function must only be called on desktop.
 */

import { isInsideRoot, decodePathSafe, isHiddenPath } from "./security";

export interface ServerHandle {
	port: number;
	close(): void;
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".wasm": "application/wasm",
	".txt": "text/plain; charset=utf-8",
};

/**
 * Starts the loopback HTTP server.  Lazy-requires Node modules so this file
 * can be bundled on mobile without evaluation-time crashes.
 */
export async function startDesktopServer(vaultRoot: string): Promise<ServerHandle> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const http = require("http") as typeof import("http");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require("fs") as typeof import("fs");
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const path = require("path") as typeof import("path");

	// Resolve vault root through any symlinks once at startup
	let resolvedVaultRoot: string;
	try {
		resolvedVaultRoot = fs.realpathSync(vaultRoot);
	} catch {
		resolvedVaultRoot = vaultRoot;
	}

	const server = http.createServer((req, res) => {
		const rawUrl = req.url ?? "/";

		// FIX 2: safe decode — return 400 on malformed percent sequences
		const decoded = decodePathSafe(rawUrl);
		if (decoded === null) {
			res.writeHead(400);
			res.end("Bad Request");
			return;
		}

		// FIX 5: a decoded NUL or other control character is never a file name. fs APIs throw synchronously on
		// NUL, so refuse before any of them is called.
		// eslint-disable-next-line no-control-regex
		if (/[\u0000-\u001f\u007f]/.test(decoded)) {
			res.writeHead(400);
			res.end("Bad Request");
			return;
		}

		const requestedPath = decoded;

		// FIX 3: Hidden path check
		if (isHiddenPath(requestedPath)) {
			res.writeHead(403);
			res.end("Forbidden");
			return;
		}

		const rawResolved = path.normalize(path.join(resolvedVaultRoot, requestedPath));

		// FIX 4: Resolve symlinks in the requested path before containment check
		try {
		fs.realpath(rawResolved, (realpathErr, resolved) => {
			const finalPath = realpathErr ? rawResolved : resolved;

			// FIX 1: Separator-aware containment (not just startsWith)
			if (!isInsideRoot(resolvedVaultRoot, finalPath)) {
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}

			// Hidden path check on the resolved path as well
			const relToRoot = finalPath.slice(resolvedVaultRoot.length);
			if (isHiddenPath(relToRoot)) {
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}

			fs.readFile(finalPath, (err, data) => {
				if (err) {
					res.writeHead(404);
					res.end("Not found");
					return;
				}
				const ext = path.extname(finalPath).toLowerCase();
				res.writeHead(200, {
					"Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
				});
				res.end(data);
			});
		});
		} catch {
			// Defence in depth: a synchronous fs failure must answer the request, not crash the process.
			res.writeHead(400);
			res.end("Bad Request");
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	const address = server.address();
	const port =
		typeof address === "object" && address ? address.port : 0;

	return {
		port,
		close: () => server.close(),
	};
}
