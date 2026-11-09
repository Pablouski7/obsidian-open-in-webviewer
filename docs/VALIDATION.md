# Validation — mobile integration 1.2.0

## Executed checks

- `npm test`: **98 passed, 0 failed, 0 skipped**; includes 18 focused security-hardening cases.
- `npm run typecheck`: passed (`--skipLibCheck` for SDK declarations).
- `npm run build`: passed; shipping target ES2018, minified CommonJS.
- `git diff --cached --check`: passed.
- Production dependency audit: no reported advisories at the time of validation.
- Independent source review after fixes: passed, no remaining concrete security or logic findings. Suggestions were limited to active-leaf choice in split layouts and feedback for overlapping navigation requests.

## Actual browser execution

The real plugin entry, registered FileView factory, resolver, IPC and UI were exercised in sandboxed headless Chromium with a synthetic Obsidian SDK seam. Two private class documents were tested separately outside this repository using the **actual minified production bundle**, not just a source build:

- CV: clicking its real `#codigo` link retained the same document and the nonempty code/practice section; theme script and storage fallback worked, no runtime exceptions.
- Quiz document: all 10 answer groups could be selected and evaluated with a nonempty result.
- Host DOM isolation remained intact; module evaluation required only `obsidian`, not Node/Electron.

At 390 px and 320 px width the primary toolbar measured **48 px**, with 44 px touch targets and no horizontal spill. Search replaces that row; other tools and diagnostics overlay the document. No script opt-in checkbox or duplicate native header actions are added.

## Limits of the evidence

This is **not native iOS/Android or real Obsidian runtime certification**. The SDK seam simulates file/workspace lifecycle, icons and native header layout. Validate in a separate native vault before production deployment.

Scripts run automatically for trusted HTML. Storage fallback is per-render memory only; reload/navigation loses it. Remote subresources and runtime fetch are blocked, but CSP cannot prevent a document script navigating its own iframe. External links produce a Notice for manual handling, not automatic host windows. Desktop retains its different, less restricted loopback-server model.

No personal recaps, browser profiles, phone backups or evaluation transcripts are included in this repository.
