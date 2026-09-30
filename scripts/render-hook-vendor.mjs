#!/usr/bin/env node
// render-hook-vendor.mjs — bundle the build-view resolver INSIDE the plugin (distribute-what-we-use D5).
//
//   node scripts/render-hook-vendor.mjs            # (re)write plugins/golden-frijoles/hooks/vendor/
//   node scripts/render-hook-vendor.mjs --check    # exit 1 if the bundle is stale, missing or padded
//
// ── Why a bundle, and why it is always used ─────────────────────────────────────────────────────
// The build view is AUTOMATIC: it runs on every turn in whatever repo the user opens. Automatic
// behaviour must not run repo-supplied code (LEARNINGS, golden-frijoles-plugin), and until this file
// existed the hook executed `<repo>/scripts/build-state.mjs` — a file any repo can own, and a stranger's
// repo usually does not have. It cannot use the kit either: an npx inside a 5-second hook is a network
// call on every turn. And the installed plugin holds only `agents/ hooks/ skills/` (measured in
// ~/.claude/plugins/cache/…), so `template/scripts/` is not there to reach.
//
// So the resolver's import closure is copied next to the hook, from the ONE source
// (`template/scripts/`), and `--check` fails CI the moment the two differ. The closure is derived from
// the real imports (check-skill-scripts' importClosure), never a hand list.
//
// Zero deps — Node 18+.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importClosure } from './check-skill-scripts.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_DIR = join(repoRoot, 'template', 'scripts');
export const VENDOR_DIR = join(repoRoot, 'plugins', 'golden-frijoles', 'hooks', 'vendor');
export const ENTRY = 'build-state.mjs';

/** The files the bundle must hold: the entry plus its relative-import closure. Throws on a broken import. */
export function vendorManifest({ sourceDir = SOURCE_DIR, read = readFileSync, exists = existsSync } = {}) {
  const { files, broken } = importClosure(ENTRY, { scriptsDir: sourceDir, read, exists });
  if (broken.length)
    throw new Error(`build-state's closure has a broken import: ${broken.map((b) => `${b.from} → ${b.to}`).join(', ')}`);
  return [ENTRY, ...files].sort();
}

function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    // POSIX separators, to compare with the manifest on Windows too (agy on #189).
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split(sep).join('/')];
  });
}

/** Pure given the fs — what differs between the source closure and the bundle. */
export function vendorDrift({ manifest = vendorManifest(), sourceDir = SOURCE_DIR, vendorDir = VENDOR_DIR } = {}) {
  const stale = manifest.filter((rel) => {
    const v = join(vendorDir, rel);
    return !existsSync(v) || !readFileSync(v).equals(readFileSync(join(sourceDir, rel)));
  });
  const extra = listFiles(vendorDir).filter((rel) => !manifest.includes(rel));
  return { stale, extra };
}

export function writeVendor({ manifest = vendorManifest(), sourceDir = SOURCE_DIR, vendorDir = VENDOR_DIR } = {}) {
  rmSync(vendorDir, { recursive: true, force: true });
  for (const rel of manifest) {
    mkdirSync(dirname(join(vendorDir, rel)), { recursive: true });
    writeFileSync(join(vendorDir, rel), readFileSync(join(sourceDir, rel)));
  }
  return manifest;
}

// realpath on both sides: invoked through a symlinked path (macOS /tmp → /private/tmp) a plain compare is
// false, and the script would exit 0 having checked nothing (#189 review).
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.argv.includes('--check')) {
    const { stale, extra } = vendorDrift();
    if (stale.length || extra.length) {
      process.stderr.write(
        `render-hook-vendor: the build-view bundle is out of date.\n` +
          (stale.length ? `  stale or missing: ${stale.join(', ')}\n` : '') +
          (extra.length ? `  not in the closure: ${extra.join(', ')}\n` : '') +
          `  Fix: node scripts/render-hook-vendor.mjs (from skills/), and commit hooks/vendor/.\n`
      );
      process.exit(1);
    }
    process.stdout.write('render-hook-vendor: the build-view bundle matches template/scripts/.\n');
  } else {
    const files = writeVendor();
    process.stdout.write(`render-hook-vendor: wrote ${files.length} file(s): ${files.join(', ')}\n`);
  }
}
