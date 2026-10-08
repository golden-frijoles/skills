#!/usr/bin/env node
// render-hook-vendor.mjs — bundle the build-view resolver (and the refine kickoff builder) INSIDE the plugin
// (distribute-what-we-use D5; board-sinks-and-scrumban D17).
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

// board-sinks-and-scrumban D17 — a SECOND bundle, same rule. The refine skill's kickoff generators live in
// `template/scripts/` (so the Hub card, the kit and the plugin print one kickoff), and an installed plugin cannot reach
// `template/scripts/` any more than the hook can. Each bundle is one entry plus its
// real import closure, written next to the code that imports it.
export const BUNDLES = Object.freeze([
  // + the usage refresh the mod runs on session.measure (finops S1.3, D24) — an entry of its own, same rule.
  { name: 'the build-view bundle', entry: ENTRY, also: ['epic-actuals.mjs'], vendorDir: VENDOR_DIR, fix: 'hooks/vendor/' },
  {
    name: 'the refine kickoff bundle',
    // kickoff-generator-path C1: the generators themselves, not only their builder. Their import closure brings
    // `emit-kickoff.mjs`, `lib/epic-kickoff.mjs`, `lib/wip.mjs`, `lib/kickoff-cli.mjs` and the extractor chain;
    // `templates/kickoff.md` is read, not imported, so it is named. The copies sit in `vendor/`, beside their `lib/`,
    // because the source's `./lib/…` imports must resolve unchanged and writeVendor empties the directory first.
    entry: 'emit-epic-kickoff.mjs',
    also: ['templates/kickoff.md'],
    vendorDir: join(repoRoot, 'plugins', 'golden-frijoles', 'skills', 'refine', 'vendor'),
    fix: 'skills/refine/vendor/',
  },
]);

/** The files the bundle must hold: the entry plus its relative-import closure. Throws on a broken import. */
export function vendorManifest({ sourceDir = SOURCE_DIR, read = readFileSync, exists = existsSync, entry = ENTRY } = {}) {
  const { files, broken } = importClosure(entry, { scriptsDir: sourceDir, read, exists });
  if (broken.length)
    throw new Error(`${entry}'s closure has a broken import: ${broken.map((b) => `${b.from} → ${b.to}`).join(', ')}`);
  return [entry, ...files].sort();
}

/** A bundle's files: the union of its entries' closures (`entry` plus any `also`). */
export function bundleManifest(bundle, opts = {}) {
  const all = [bundle.entry, ...(bundle.also ?? [])].flatMap((entry) => vendorManifest({ ...opts, entry }));
  return [...new Set(all)].sort();
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
  let failed = false;
  for (const bundle of BUNDLES) {
    const manifest = bundleManifest(bundle);
    if (process.argv.includes('--check')) {
      const { stale, extra } = vendorDrift({ manifest, vendorDir: bundle.vendorDir });
      if (stale.length || extra.length) {
        failed = true;
        process.stderr.write(
          `render-hook-vendor: ${bundle.name} is out of date.\n` +
            (stale.length ? `  stale or missing: ${stale.join(', ')}\n` : '') +
            (extra.length ? `  not in the closure: ${extra.join(', ')}\n` : '') +
            `  Fix: node scripts/render-hook-vendor.mjs (from skills/), and commit ${bundle.fix}.\n`
        );
      } else process.stdout.write(`render-hook-vendor: ${bundle.name} matches template/scripts/.\n`);
    } else {
      const files = writeVendor({ manifest, vendorDir: bundle.vendorDir });
      process.stdout.write(`render-hook-vendor: ${bundle.name} — wrote ${files.length} file(s): ${files.join(', ')}\n`);
    }
  }
  if (failed) process.exit(1);
}
