// is-main.mjs — "was this file run directly, or imported?" — the ONE answer every rail entry uses
// (template-scripts-consumer-gates D4).
//
//   if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));   // isMain from lib/is-main.mjs
//
// ── Why realpath on BOTH sides ──────────────────────────────────────────────────────────────────
// `process.argv[1]` is the path as typed; `import.meta.url` is where Node loaded the module from. Run
// through a symlinked path (macOS /tmp → /private/tmp, /var → /private/var, a symlinked checkout) the two
// spell different paths for one file, a lexical compare is false, and the script does nothing and exits
// 0: a silent no-op that reads as success. Node realpaths the main module by default, but not under
// --preserve-symlinks-main, so the module side is resolved too. 59 entries spelled this six ways
// before this file existed; `check-is-main.mjs` now fails CI on any other spelling.
//
// Zero deps — Node 18+.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when the module at `metaUrl` is the script Node was asked to run. Never throws. */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    // A path that no longer resolves (a deleted temp file, an eval'd module) is not "run directly".
    return false;
  }
}
